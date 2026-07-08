/**
 * Drizzle Workflow Queue
 *
 * Production {@link WorkflowQueue} backed by PostgreSQL. Implements the
 * SQS-style visibility-timeout contract with atomic claim semantics via
 * `FOR UPDATE SKIP LOCKED`, plus run fencing:
 *
 * Every successful `dequeue()` increments `workflow_runs.claim_epoch` for
 * the job's run (upserting the run row for fresh starts) and returns the
 * new epoch on the job. Fenced persistence/event-log writers (see
 * `createFencedRunnerOptions`) carry that epoch on every write and the
 * adapter rejects stale epochs with `StaleClaimError` — so a worker whose
 * job was reclaimed (GC pause, network partition) cannot clobber the new
 * claimant's writes no matter how long it keeps running.
 *
 * @module @cycgraph/orchestrator-postgres/drizzle-queue
 */

import { workflow_jobs, workflow_runs } from './schema.js';
import type { WorkflowJobRow } from './schema.js';
import { eq, and, sql, asc, lte, or, isNull, type SQL } from 'drizzle-orm';
import { withPlatform } from './tenancy.js';
import type { WorkflowQueue, WorkflowJob, EnqueueJobInput, QueueDepth, WorkflowQueueOptions } from '@cycgraph/orchestrator';
import { retryBackoffDelayMs } from '@cycgraph/orchestrator';

const DEFAULT_RETRY_BACKOFF_MS = 1000;
const DEFAULT_RETRY_BACKOFF_MAX_MS = 300_000;

/**
 * PostgreSQL-backed workflow job queue with fencing-epoch claims.
 *
 * The queue is a **platform-plane** component: it dequeues/reclaims across all
 * tenants and upserts run rows with an explicit `tenant_id`. Every method runs
 * through {@link withPlatform} (the BYPASSRLS connection under FORCE RLS), NOT
 * the tenant-subject connection — otherwise, once migration 0019 enforces RLS
 * with a non-superuser owner, `dequeue`'s cross-tenant select would return zero
 * rows (no `app.tenant_id` GUC is set) and job delivery would silently stop.
 */
export class DrizzleWorkflowQueue implements WorkflowQueue {
  private readonly retryBackoffMs: number;
  private readonly retryBackoffMaxMs: number;

  constructor(options?: WorkflowQueueOptions) {
    this.retryBackoffMs = options?.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
    this.retryBackoffMaxMs = options?.retryBackoffMaxMs ?? DEFAULT_RETRY_BACKOFF_MAX_MS;
  }

  /**
   * Ownership predicate for lifecycle ops (ack/nack/heartbeat/release): scope
   * the write to the caller's claimed job. `undefined` when no `workerId` is
   * supplied (ignored by `and()`), preserving the ownership-agnostic behavior.
   */
  private ownedBy(workerId?: string): SQL | undefined {
    return workerId !== undefined ? eq(workflow_jobs.worker_id, workerId) : undefined;
  }

  async enqueue(input: EnqueueJobInput): Promise<string> {
    return withPlatform(async (db) => {
      const rows = await db.insert(workflow_jobs).values({
        type: input.type,
        // Opaque tenant tag; omitted (DB seed default) for single-tenant callers.
        ...(input.tenant_id ? { tenant_id: input.tenant_id } : {}),
        run_id: input.run_id,
        graph_id: input.graph_id,
        initial_state: input.initial_state ?? null,
        human_response: input.human_response ?? null,
        priority: input.priority ?? 0,
        max_attempts: input.max_attempts ?? 3,
        visibility_timeout_ms: input.visibility_timeout_ms ?? 300_000,
      }).returning({ id: workflow_jobs.id });
      return rows[0].id;
    });
  }

  /**
   * Atomically claim the highest-priority waiting job.
   *
   * `FOR UPDATE SKIP LOCKED` guarantees exactly one worker wins each job
   * without blocking concurrent dequeues. The same transaction bumps the
   * run's `claim_epoch` (creating the run row for 'start' jobs — the row
   * must exist before the runner's first event append anyway, because
   * `workflow_events.run_id` has a foreign key on it).
   */
  async dequeue(workerId: string): Promise<WorkflowJob | null> {
    return withPlatform((db) => db.transaction(async (tx) => {
      const now = new Date();
      const candidates = await tx
        .select()
        .from(workflow_jobs)
        .where(
          and(
            eq(workflow_jobs.status, 'waiting'),
            // Retry backoff: skip jobs not yet visible (fresh enqueues have
            // visible_at=null → immediately visible).
            or(isNull(workflow_jobs.visible_at), lte(workflow_jobs.visible_at, now)),
          ),
        )
        .orderBy(asc(workflow_jobs.priority), asc(workflow_jobs.created_at))
        .limit(1)
        .for('update', { skipLocked: true });

      const job = candidates[0];
      if (!job) return null;
      const updated = await tx
        .update(workflow_jobs)
        .set({
          status: 'active',
          worker_id: workerId,
          attempt: job.attempt + 1,
          visible_at: new Date(now.getTime() + job.visibility_timeout_ms),
          last_heartbeat_at: now,
        })
        .where(eq(workflow_jobs.id, job.id))
        .returning();

      // Fencing: bump the run's claim epoch. Upsert handles fresh runs —
      // the graph row must already exist (graphs are saved before enqueue).
      // Carry the job's tenant onto the run it creates so the run row lands in
      // the correct tenant (the worker then executes under withTenant). Cross-
      // tenant platform write: the queue runs as the bypass role, so the
      // explicit tenant_id is honoured even once RLS is enforced.
      const epochRows = await tx
        .insert(workflow_runs)
        .values({
          id: job.run_id,
          ...(job.tenant_id ? { tenant_id: job.tenant_id } : {}),
          graph_id: job.graph_id,
          status: 'pending',
          claim_epoch: 1,
        })
        .onConflictDoUpdate({
          target: workflow_runs.id,
          set: { claim_epoch: sql`${workflow_runs.claim_epoch} + 1` },
        })
        .returning({ claim_epoch: workflow_runs.claim_epoch });

      return fromRow(updated[0], epochRows[0]?.claim_epoch);
    }));
  }

  async ack(jobId: string, workerId?: string): Promise<void> {
    await withPlatform((db) => db
      .update(workflow_jobs)
      .set({ status: 'completed', visible_at: null })
      .where(and(eq(workflow_jobs.id, jobId), this.ownedBy(workerId))));
  }

  async nack(jobId: string, error: string, workerId?: string): Promise<void> {
    await withPlatform((db) => db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(workflow_jobs)
        .where(and(eq(workflow_jobs.id, jobId), this.ownedBy(workerId)))
        .limit(1)
        .for('update');
      const job = rows[0];
      if (!job) return;

      const exhausted = job.attempt >= job.max_attempts;
      // Retry backoff: delay re-visibility so a fast-failing job doesn't burn
      // its remaining attempts in a tight loop.
      const delay = exhausted ? 0 : retryBackoffDelayMs(job.attempt, this.retryBackoffMs, this.retryBackoffMaxMs);
      await tx
        .update(workflow_jobs)
        .set({
          status: exhausted ? 'dead_letter' : 'waiting',
          worker_id: null,
          visible_at: delay > 0 ? new Date(Date.now() + delay) : null,
          last_error: error,
        })
        .where(eq(workflow_jobs.id, jobId));
    }));
  }

  async heartbeat(jobId: string, extendMs?: number, workerId?: string): Promise<void> {
    const now = new Date();
    await withPlatform((db) => db
      .update(workflow_jobs)
      .set({
        last_heartbeat_at: now,
        visible_at: sql`${now.toISOString()}::timestamptz + (COALESCE(${extendMs ?? null}::integer, visibility_timeout_ms) * interval '1 millisecond')`,
      })
      .where(and(eq(workflow_jobs.id, jobId), eq(workflow_jobs.status, 'active'), this.ownedBy(workerId))));
  }

  async release(jobId: string, workerId?: string): Promise<void> {
    await withPlatform((db) => db
      .update(workflow_jobs)
      .set({ status: 'paused', worker_id: null, visible_at: null })
      .where(and(eq(workflow_jobs.id, jobId), this.ownedBy(workerId))));
  }

  async reclaimExpired(): Promise<number> {
    const now = new Date();
    return withPlatform(async (db) => {
      const rows = await db
        .update(workflow_jobs)
        .set({
          // A reclaim IS a failed attempt: the worker was claimed (attempt was
          // incremented at dequeue) but died without ack/nack. Apply the same
          // exhaustion check nack() uses so a job that reliably crashes its
          // worker is dead-lettered after max_attempts instead of looping
          // forever (visibility expires → reclaim → dequeue → crash → …).
          status: sql`CASE WHEN ${workflow_jobs.attempt} >= ${workflow_jobs.max_attempts} THEN 'dead_letter' ELSE 'waiting' END`,
          worker_id: null,
          visible_at: null,
        })
        .where(
          and(
            eq(workflow_jobs.status, 'active'),
            or(isNull(workflow_jobs.visible_at), lte(workflow_jobs.visible_at, now)),
          ),
        )
        .returning({ id: workflow_jobs.id });
      return rows.length;
    });
  }

  async getJob(jobId: string): Promise<WorkflowJob | null> {
    return withPlatform(async (db) => {
      const rows = await db
        .select()
        .from(workflow_jobs)
        .where(eq(workflow_jobs.id, jobId))
        .limit(1);
      return rows[0] ? fromRow(rows[0]) : null;
    });
  }

  async getQueueDepth(): Promise<QueueDepth> {
    return withPlatform(async (db) => {
      const rows = await db
        .select({
          status: workflow_jobs.status,
          count: sql<number>`COUNT(*)::int`,
        })
        .from(workflow_jobs)
        .groupBy(workflow_jobs.status);

      const byStatus = new Map(rows.map(r => [r.status, r.count]));
      return {
        waiting: byStatus.get('waiting') ?? 0,
        active: byStatus.get('active') ?? 0,
        paused: byStatus.get('paused') ?? 0,
        dead_letter: byStatus.get('dead_letter') ?? 0,
      };
    });
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────

function fromRow(row: WorkflowJobRow, claimEpoch?: number): WorkflowJob {
  return {
    id: row.id,
    type: row.type,
    tenant_id: row.tenant_id,
    run_id: row.run_id,
    graph_id: row.graph_id,
    initial_state: row.initial_state ?? undefined,
    human_response: row.human_response ?? undefined,
    priority: row.priority,
    max_attempts: row.max_attempts,
    attempt: row.attempt,
    visibility_timeout_ms: row.visibility_timeout_ms,
    status: row.status,
    worker_id: row.worker_id,
    created_at: row.created_at,
    visible_at: row.visible_at,
    last_heartbeat_at: row.last_heartbeat_at,
    last_error: row.last_error,
    ...(claimEpoch !== undefined ? { claim_epoch: claimEpoch } : {}),
  };
}
