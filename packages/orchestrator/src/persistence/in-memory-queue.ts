/**
 * In-Memory Workflow Queue
 *
 * Map-based implementation of {@link WorkflowQueue} for testing
 * and lightweight deployments. Follows the same patterns as
 * {@link InMemoryPersistenceProvider}.
 *
 * Data is lost when the process exits — use a Drizzle/Postgres
 * implementation for production.
 *
 * @module persistence/in-memory-queue
 */

import { WorkflowJobSchema } from './queue-interfaces.js';
import type {
  WorkflowJob,
  WorkflowQueue,
  EnqueueJobInput,
  QueueDepth,
} from './queue-interfaces.js';

/** Tuning knobs shared by the queue implementations. */
export interface WorkflowQueueOptions {
  /**
   * Base retry backoff in ms. A `nack`ed job is made invisible for
   * `min(retryBackoffMs * 2^(attempt-1), retryBackoffMaxMs)` before it can be
   * re-dequeued, so a fast-failing job doesn't burn all its attempts in a tight
   * loop (and a flaky dependency gets a breather). Set to `0` to retry
   * immediately (the pre-backoff behavior). @default 1000
   */
  retryBackoffMs?: number;
  /** Cap on the exponential backoff. @default 300000 (5 min) */
  retryBackoffMaxMs?: number;
}

const DEFAULT_RETRY_BACKOFF_MS = 1000;
const DEFAULT_RETRY_BACKOFF_MAX_MS = 300_000;

/**
 * Compute the retry delay for the Nth attempt: bounded exponential backoff.
 * Returns 0 when `base` is 0 (immediate retry).
 */
export function retryBackoffDelayMs(attempt: number, base: number, max: number): number {
  if (base <= 0) return 0;
  const exp = base * Math.pow(2, Math.max(0, attempt - 1));
  return Math.min(exp, max);
}

/**
 * In-memory workflow queue.
 *
 * - `dequeue` sorts by `(priority ASC, created_at ASC)`, filters `status === 'waiting'`
 *   and skips jobs whose `visible_at` is still in the future (retry backoff)
 * - `reclaimExpired` scans for `active` jobs where `visible_at <= now`
 */
export class InMemoryWorkflowQueue implements WorkflowQueue {
  private readonly jobs = new Map<string, WorkflowJob>();
  /** Per-run fencing epochs, bumped on every claim (parity with DrizzleWorkflowQueue). */
  private readonly runEpochs = new Map<string, number>();
  private readonly retryBackoffMs: number;
  private readonly retryBackoffMaxMs: number;

  constructor(options?: WorkflowQueueOptions) {
    this.retryBackoffMs = options?.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
    this.retryBackoffMaxMs = options?.retryBackoffMaxMs ?? DEFAULT_RETRY_BACKOFF_MAX_MS;
  }

  async enqueue(input: EnqueueJobInput): Promise<string> {
    const job = WorkflowJobSchema.parse({
      id: crypto.randomUUID(),
      ...input,
    });
    this.jobs.set(job.id, job);
    return job.id;
  }

  async dequeue(workerId: string): Promise<WorkflowJob | null> {
    const now = new Date();
    const waiting = [...this.jobs.values()]
      .filter(j =>
        j.status === 'waiting' &&
        // Retry backoff: skip jobs not yet visible (a fresh enqueue has
        // visible_at=null → immediately visible).
        (j.visible_at === null || j.visible_at.getTime() <= now.getTime()),
      )
      .sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority;
        return a.created_at.getTime() - b.created_at.getTime();
      });

    const job = waiting[0];
    if (!job) return null;
    // Fencing token: every claim of a run bumps its epoch, matching the
    // DrizzleWorkflowQueue contract so fenced writers behave identically
    // against both implementations.
    const epoch = (this.runEpochs.get(job.run_id) ?? 0) + 1;
    this.runEpochs.set(job.run_id, epoch);

    const updated: WorkflowJob = {
      ...job,
      status: 'active',
      worker_id: workerId,
      attempt: job.attempt + 1,
      visible_at: new Date(now.getTime() + job.visibility_timeout_ms),
      last_heartbeat_at: now,
      claim_epoch: epoch,
    };
    this.jobs.set(job.id, updated);
    return updated;
  }

  async ack(jobId: string, workerId?: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) return;
    // Ownership guard: a stale worker must not complete a job it no longer owns.
    if (workerId !== undefined && job.worker_id !== workerId) return;
    this.jobs.set(jobId, {
      ...job,
      status: 'completed',
      visible_at: null,
      worker_id: null,
    });
  }

  async nack(jobId: string, error: string, workerId?: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) return;
    if (workerId !== undefined && job.worker_id !== workerId) return;

    if (job.attempt >= job.max_attempts) {
      this.jobs.set(jobId, {
        ...job,
        status: 'dead_letter',
        last_error: error,
        visible_at: null,
        worker_id: null,
      });
    } else {
      // Retry backoff: delay re-visibility so a fast-failing job doesn't burn
      // its remaining attempts in a tight loop.
      const delay = retryBackoffDelayMs(job.attempt, this.retryBackoffMs, this.retryBackoffMaxMs);
      this.jobs.set(jobId, {
        ...job,
        status: 'waiting',
        last_error: error,
        visible_at: delay > 0 ? new Date(Date.now() + delay) : null,
        worker_id: null,
      });
    }
  }

  async heartbeat(jobId: string, extendMs?: number, workerId?: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== 'active') return;
    if (workerId !== undefined && job.worker_id !== workerId) return;

    const extension = extendMs ?? job.visibility_timeout_ms;
    const now = new Date();
    this.jobs.set(jobId, {
      ...job,
      visible_at: new Date(now.getTime() + extension),
      last_heartbeat_at: now,
    });
  }

  async release(jobId: string, workerId?: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) return;
    if (workerId !== undefined && job.worker_id !== workerId) return;
    this.jobs.set(jobId, {
      ...job,
      status: 'paused',
      visible_at: null,
      worker_id: null,
    });
  }

  async reclaimExpired(): Promise<number> {
    const now = new Date();
    let count = 0;
    for (const job of this.jobs.values()) {
      if (
        job.status === 'active' &&
        job.visible_at &&
        job.visible_at.getTime() <= now.getTime()
      ) {
        // A reclaim is a failed attempt (worker died without ack/nack). Apply
        // the same exhaustion check nack() uses so a job that reliably crashes
        // its worker is dead-lettered instead of reclaimed forever.
        const exhausted = job.attempt >= job.max_attempts;
        this.jobs.set(job.id, {
          ...job,
          status: exhausted ? 'dead_letter' : 'waiting',
          visible_at: null,
          worker_id: null,
        });
        count++;
      }
    }
    return count;
  }

  async getJob(jobId: string): Promise<WorkflowJob | null> {
    return this.jobs.get(jobId) ?? null;
  }

  async getQueueDepth(): Promise<QueueDepth> {
    let waiting = 0;
    let active = 0;
    let paused = 0;
    let dead_letter = 0;
    for (const job of this.jobs.values()) {
      if (job.status === 'waiting') waiting++;
      else if (job.status === 'active') active++;
      else if (job.status === 'paused') paused++;
      else if (job.status === 'dead_letter') dead_letter++;
    }
    return { waiting, active, paused, dead_letter };
  }

  /** Clear all jobs (test utility). */
  clear(): void {
    this.jobs.clear();
  }
}
