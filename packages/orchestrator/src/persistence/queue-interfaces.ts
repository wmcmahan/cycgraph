/**
 * Workflow Queue Interfaces
 *
 * Defines the contract for a workflow job queue used by
 * {@link WorkflowWorker} to distribute workflow execution
 * across multiple worker processes.
 *
 * Design: SQS-style visibility-timeout queue with explicit
 * ack/nack/release semantics. `release` is distinct from `nack` —
 * HITL pauses release without penalizing the attempt count.
 *
 * @module persistence/queue-interfaces
 */

import { z } from 'zod';

// ─── Schemas ────────────────────────────────────────────────────────────

/** Status of a workflow job in the queue. */
export const WorkflowJobStatusSchema = z.enum([
  'waiting',
  'active',
  'paused',
  'completed',
  'failed',
  'dead_letter',
]);

export type WorkflowJobStatus = z.infer<typeof WorkflowJobStatusSchema>;

/** Schema for a workflow job. */
export const WorkflowJobSchema = z.object({
  /** Unique job identifier (auto-generated). */
  id: z.string().uuid(),
  /** Whether this is a new run or a crash/HITL resume. */
  type: z.enum(['start', 'resume']),
  /**
   * Owning tenant (opaque metadata — the queue is cross-tenant platform
   * infrastructure and never filters on this). Carried so a worker that
   * claims the job can re-enter the tenant plane to execute the run.
   * Optional: single-tenant deployments leave it unset (falls to the DB
   * seed-tenant default).
   */
  tenant_id: z.string().uuid().optional(),
  /** Workflow run ID. */
  run_id: z.string().uuid(),
  /** Graph to load and execute. */
  graph_id: z.string().uuid(),
  /** Initial state (only for 'start' jobs). */
  initial_state: z.unknown().optional(),
  /** Human response payload (only for 'resume' after HITL). */
  human_response: z.unknown().optional(),
  /** Job priority — lower values are dequeued first. */
  priority: z.number().int().default(0),
  /** Maximum attempts before dead-lettering. */
  max_attempts: z.number().int().default(3),
  /** Current attempt number. */
  attempt: z.number().int().default(0),
  /** Visibility timeout in milliseconds (default 5 minutes). */
  visibility_timeout_ms: z.number().int().default(300_000),
  /** Current job status. */
  status: WorkflowJobStatusSchema.default('waiting'),
  /** ID of the worker processing this job. */
  worker_id: z.string().nullable().default(null),
  /** When the job was created. */
  created_at: z.date().default(() => new Date()),
  /** When the job becomes visible again (for active jobs). */
  visible_at: z.date().nullable().default(null),
  /** Last heartbeat timestamp from the processing worker. */
  last_heartbeat_at: z.date().nullable().default(null),
  /** Error message from the last failed attempt. */
  last_error: z.string().nullable().default(null),
  /**
   * Fencing token for this claim. Incremented on the run every time a
   * worker claims a job for it — fenced persistence/event-log writers
   * reject writes carrying a stale epoch, so a paused-but-alive worker
   * whose job was reclaimed cannot clobber the new claimant's writes.
   */
  claim_epoch: z.number().int().optional(),
});

export type WorkflowJob = z.infer<typeof WorkflowJobSchema>;

/** Input shape for enqueuing a new job. */
export type EnqueueJobInput = Pick<WorkflowJob, 'type' | 'run_id' | 'graph_id'> &
  Partial<Pick<WorkflowJob, 'tenant_id' | 'initial_state' | 'human_response' | 'priority' | 'max_attempts' | 'visibility_timeout_ms'>>;

// ─── Queue Interface ────────────────────────────────────────────────────

/** Depth counts by status category. */
export interface QueueDepth {
  waiting: number;
  active: number;
  paused: number;
  dead_letter: number;
}

/**
 * Workflow job queue interface.
 *
 * Implementations must provide atomic claim semantics on `dequeue`
 * (only one worker can claim a given job) and visibility-timeout-based
 * crash recovery via `reclaimExpired`.
 */
export interface WorkflowQueue {
  /** Add a job to the queue. Returns the auto-generated job ID. */
  enqueue(input: EnqueueJobInput): Promise<string>;

  /**
   * Atomically claim the highest-priority waiting job.
   *
   * Transitions: waiting → active, sets `worker_id`, `visible_at`,
   * and increments `attempt`. Returns `null` if no jobs are waiting.
   */
  dequeue(workerId: string): Promise<WorkflowJob | null>;

  /** Mark a job as completed. */
  ack(jobId: string): Promise<void>;

  /**
   * Report a job failure.
   *
   * If `attempt < max_attempts`, the job returns to `waiting` for retry.
   * Otherwise, it transitions to `dead_letter`.
   */
  nack(jobId: string, error: string): Promise<void>;

  /**
   * Extend the visibility timeout for an active job (heartbeat).
   *
   * @param extendMs Additional milliseconds to extend (defaults to the job's `visibility_timeout_ms`).
   */
  heartbeat(jobId: string, extendMs?: number): Promise<void>;

  /**
   * Pause a job without incrementing the attempt count.
   *
   * Used for HITL pauses — transitions to `paused` status so the job
   * is NOT re-claimable by `dequeue`. A separate `resume` job must be
   * enqueued to continue the workflow.
   */
  release(jobId: string): Promise<void>;

  /**
   * Reclaim jobs with expired visibility timeouts (crash recovery).
   *
   * Active jobs whose `visible_at` has passed are returned to `waiting`.
   * Returns the number of jobs reclaimed.
   */
  reclaimExpired(): Promise<number>;

  /** Load a job by ID (for diagnostics). Returns `null` if not found. */
  getJob(jobId: string): Promise<WorkflowJob | null>;

  /** Get queue depth counts by status category. */
  getQueueDepth(): Promise<QueueDepth>;
}
