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

/**
 * In-memory workflow queue.
 *
 * - `dequeue` sorts by `(priority ASC, created_at ASC)` and filters `status === 'waiting'`
 * - `reclaimExpired` scans for `active` jobs where `visible_at <= now`
 */
export class InMemoryWorkflowQueue implements WorkflowQueue {
  private readonly jobs = new Map<string, WorkflowJob>();
  /** Per-run fencing epochs, bumped on every claim (parity with DrizzleWorkflowQueue). */
  private readonly runEpochs = new Map<string, number>();

  async enqueue(input: EnqueueJobInput): Promise<string> {
    const job = WorkflowJobSchema.parse({
      id: crypto.randomUUID(),
      ...input,
    });
    this.jobs.set(job.id, job);
    return job.id;
  }

  async dequeue(workerId: string): Promise<WorkflowJob | null> {
    const waiting = [...this.jobs.values()]
      .filter(j => j.status === 'waiting')
      .sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority;
        return a.created_at.getTime() - b.created_at.getTime();
      });

    const job = waiting[0];
    if (!job) return null;

    const now = new Date();
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

  async ack(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) return;
    this.jobs.set(jobId, {
      ...job,
      status: 'completed',
      visible_at: null,
      worker_id: null,
    });
  }

  async nack(jobId: string, error: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) return;

    if (job.attempt >= job.max_attempts) {
      this.jobs.set(jobId, {
        ...job,
        status: 'dead_letter',
        last_error: error,
        visible_at: null,
        worker_id: null,
      });
    } else {
      this.jobs.set(jobId, {
        ...job,
        status: 'waiting',
        last_error: error,
        visible_at: null,
        worker_id: null,
      });
    }
  }

  async heartbeat(jobId: string, extendMs?: number): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== 'active') return;

    const extension = extendMs ?? job.visibility_timeout_ms;
    const now = new Date();
    this.jobs.set(jobId, {
      ...job,
      visible_at: new Date(now.getTime() + extension),
      last_heartbeat_at: now,
    });
  }

  async release(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) return;
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
        this.jobs.set(job.id, {
          ...job,
          status: 'waiting',
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
