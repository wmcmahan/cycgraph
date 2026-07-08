/**
 * Drizzle Event Log Writer
 *
 * Production event log writer backed by PostgreSQL.
 * Implements EventLogWriter from @cycgraph/orchestrator.
 */

import { db } from './connection.js';
import { workflow_events, workflow_checkpoints, workflow_runs } from './schema.js';
import type { WorkflowStateJson } from './schema.js';
import { eq, and, desc, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { withTenant, type Tx, type TenantContext } from './tenancy.js';
import type { EventLogWriter } from '@cycgraph/orchestrator';
import type { NewWorkflowEvent, WorkflowEvent, Action, WorkflowState } from '@cycgraph/orchestrator';
import { hydrateWorkflowState, EventSequenceConflictError, StaleClaimError } from '@cycgraph/orchestrator';

/** A query handle usable for both standalone (`db`) and tenant-scoped (`tx`) work. */
type Queryer = typeof db | Tx;

/** Tuning knobs for the event log writer. */
export interface DrizzleEventLogWriterOptions {
  /**
   * How many checkpoints per run to retain. Older checkpoints are pruned
   * inside the same transaction as the new write. The minimum useful value
   * is 1 (always keep at least the latest, which is what `loadCheckpoint`
   * reads). Set to a higher value if you want a small buffer for forensics
   * or differential debugging.
   * @default 3
   */
  retain_checkpoints?: number;
  /**
   * Run fencing claim. When set, every append for `fencing.run_id` verifies
   * (inside the append transaction, under `FOR SHARE`) that the run's
   * `claim_epoch` still equals `fencing.epoch` and throws
   * {@link StaleClaimError} otherwise — a reclaimed worker cannot keep
   * appending to a run another worker now owns.
   */
  fencing?: { run_id: string; epoch: number };
  /**
   * Tenant this writer operates on behalf of. When set, event/checkpoint
   * inserts stamp `tenant_id`, reads carry a `tenant_id` filter, and all work
   * runs inside {@link withTenant}. When omitted, single-tenant (seed default).
   */
  tenant?: TenantContext;
}

const DEFAULT_RETAIN_CHECKPOINTS = 3;

/**
 * Production event log writer backed by the `workflow_events` PostgreSQL table.
 */
export class DrizzleEventLogWriter implements EventLogWriter {
  private readonly retainCheckpoints: number;
  private readonly fencing?: { run_id: string; epoch: number };
  private readonly tenant?: TenantContext;

  constructor(options?: DrizzleEventLogWriterOptions) {
    const retain = options?.retain_checkpoints ?? DEFAULT_RETAIN_CHECKPOINTS;
    if (retain < 1) {
      throw new Error(
        `DrizzleEventLogWriter: retain_checkpoints must be >= 1 (got ${retain}). ` +
        `Setting to 0 would orphan the run from any usable replay anchor.`,
      );
    }
    this.retainCheckpoints = retain;
    this.fencing = options?.fencing;
    this.tenant = options?.tenant;
  }

  private get tenantValues(): { tenant_id: string } | Record<string, never> {
    return this.tenant ? { tenant_id: this.tenant.tenant_id } : {};
  }

  private tenantEq(col: AnyPgColumn): SQL | undefined {
    return this.tenant ? eq(col, this.tenant.tenant_id) : undefined;
  }

  /** Run a single read — tenant-scoped (inside withTenant) or the shared db. */
  private read<T>(fn: (q: Queryer) => Promise<T>): Promise<T> {
    return this.tenant ? withTenant(this.tenant.tenant_id, fn) : fn(db);
  }

  /** Run an atomic multi-statement write in one transaction — tenant-scoped or plain. */
  private tx<T>(fn: (tx: Queryer) => Promise<T>): Promise<T> {
    return this.tenant ? withTenant(this.tenant.tenant_id, fn) : db.transaction(fn);
  }

  /**
   * Fencing guard shared by append / checkpoint / compact: throw
   * {@link StaleClaimError} if this writer's claim epoch no longer matches the
   * run's current epoch. A reclaimed/stale worker must not be able to append
   * events, write a checkpoint, OR compact — any of which corrupts the new
   * claimant's replay (the checkpoint especially, since `loadCheckpoint`
   * anchors recovery on the highest sequence_id). Verified under `FOR SHARE`
   * inside the caller's transaction so the check and the write are atomic.
   * No-op when fencing is unset or targets a different run.
   */
  private async assertClaimEpoch(tx: Queryer, run_id: string): Promise<void> {
    if (!this.fencing || this.fencing.run_id !== run_id) return;
    const fencing = this.fencing;
    const rows = await tx
      .select({ claim_epoch: workflow_runs.claim_epoch })
      .from(workflow_runs)
      .where(and(eq(workflow_runs.id, run_id), this.tenantEq(workflow_runs.tenant_id)))
      .for('share');
    const current = rows[0]?.claim_epoch;
    if (current !== undefined && current !== fencing.epoch) {
      throw new StaleClaimError(run_id, fencing.epoch, current);
    }
  }

  async append(event: NewWorkflowEvent): Promise<void> {
    const values = {
      ...this.tenantValues,
      run_id: event.run_id,
      sequence_id: event.sequence_id,
      event_type: event.event_type as 'workflow_started' | 'node_started' | 'action_dispatched' | 'internal_dispatched' | 'state_persisted',
      node_id: event.node_id ?? null,
      action: event.action ? toSerializable(event.action) : null,
      internal_type: event.internal_type ?? null,
      internal_payload: event.internal_payload ?? null,
      created_at: new Date(),
    };
    try {
      if (this.fencing && this.fencing.run_id === event.run_id) {
        // FOR SHARE allows concurrent appends from the legitimate claimant
        // while conflicting with the FOR UPDATE epoch bump in dequeue — the
        // epoch check and the insert are atomic.
        await this.tx(async (tx) => {
          await this.assertClaimEpoch(tx, event.run_id);
          await tx.insert(workflow_events).values(values);
        });
      } else {
        await this.read((q) => q.insert(workflow_events).values(values));
      }
    } catch (error) {
      // A (run_id, sequence_id) unique violation means another writer is
      // appending to this run — surface it as a sequence conflict instead of
      // silently dropping the event (the old onConflictDoNothing behavior
      // masked split-brain executions).
      if (isUniqueViolation(error)) {
        throw new EventSequenceConflictError(event.run_id, event.sequence_id);
      }
      throw error;
    }
  }

  async loadEvents(run_id: string): Promise<WorkflowEvent[]> {
    const rows = await this.read((q) => q
      .select()
      .from(workflow_events)
      .where(and(eq(workflow_events.run_id, run_id), this.tenantEq(workflow_events.tenant_id)))
      .orderBy(workflow_events.sequence_id));
    return rows.map(fromRow);
  }

  async loadEventsAfter(run_id: string, afterSequenceId: number): Promise<WorkflowEvent[]> {
    const rows = await this.read((q) => q
      .select()
      .from(workflow_events)
      .where(
        and(
          eq(workflow_events.run_id, run_id),
          sql`${workflow_events.sequence_id} > ${afterSequenceId}`,
          this.tenantEq(workflow_events.tenant_id),
        )
      )
      .orderBy(workflow_events.sequence_id));
    return rows.map(fromRow);
  }

  async getLatestSequenceId(run_id: string): Promise<number> {
    const result = await this.read((q) => q
      .select({ maxSeq: sql<number>`COALESCE(MAX(${workflow_events.sequence_id}), -1)` })
      .from(workflow_events)
      .where(and(eq(workflow_events.run_id, run_id), this.tenantEq(workflow_events.tenant_id))));

    return result[0]?.maxSeq ?? -1;
  }

  async checkpoint(run_id: string, sequenceId: number, state: WorkflowState): Promise<void> {
    // Insert the new checkpoint AND prune older ones beyond the retention
    // window inside a single transaction. Doing this lazily on each write
    // means the checkpoint table never grows unbounded for a long-running
    // workflow with frequent checkpoints. Cap is enforced per run_id, so
    // pruning one run never affects another.
    await this.tx(async (tx) => {
      // Fence exactly like append/compact: a reclaimed worker must not write a
      // checkpoint for a run a NEW claimant now owns — `loadCheckpoint` anchors
      // recovery on the highest sequence_id, so a stale checkpoint would make
      // the new claimant resume from rolled-back/divergent state.
      await this.assertClaimEpoch(tx, run_id);

      await tx.insert(workflow_checkpoints).values({
        ...this.tenantValues,
        run_id,
        sequence_id: sequenceId,
        state: toSerializable(state) as WorkflowStateJson,
        created_at: new Date(),
      });

      // Identify the IDs to keep (the latest N by sequence_id) and delete
      // the rest. Using `inArray(...).not()` would be simpler but Drizzle's
      // notInArray helper isn't ergonomic across versions; a NOT IN subquery
      // is more portable.
      const keepIds = await tx
        .select({ id: workflow_checkpoints.id })
        .from(workflow_checkpoints)
        .where(and(eq(workflow_checkpoints.run_id, run_id), this.tenantEq(workflow_checkpoints.tenant_id)))
        .orderBy(desc(workflow_checkpoints.sequence_id))
        .limit(this.retainCheckpoints);

      if (keepIds.length === this.retainCheckpoints) {
        // Only prune when we actually have more than the retention count —
        // skips the DELETE entirely on the first N writes for a run.
        await tx
          .delete(workflow_checkpoints)
          .where(
            and(
              eq(workflow_checkpoints.run_id, run_id),
              sql`${workflow_checkpoints.id} NOT IN (${sql.join(keepIds.map(k => sql`${k.id}`), sql`, `)})`,
              this.tenantEq(workflow_checkpoints.tenant_id),
            ),
          );
      }
    });
  }

  async loadCheckpoint(run_id: string): Promise<{ sequence_id: number; state: WorkflowState } | null> {
    const result = await this.read((q) => q
      .select()
      .from(workflow_checkpoints)
      .where(and(eq(workflow_checkpoints.run_id, run_id), this.tenantEq(workflow_checkpoints.tenant_id)))
      .orderBy(desc(workflow_checkpoints.sequence_id))
      .limit(1));

    const row = result[0] ?? null;
    if (!row) return null;
    return {
      sequence_id: row.sequence_id,
      // jsonb loses Date types — hydrate (migrate + parse + coerce dates)
      // instead of casting, so resumed runs get real Date fields back.
      state: hydrateWorkflowState(row.state),
    };
  }

  async compact(run_id: string, beforeSequenceId: number): Promise<number> {
    return this.tx(async (tx) => {
      // Fence the delete exactly like append: a reclaimed/stale worker must not
      // be able to delete events belonging to the run a NEW claimant now owns
      // (which would corrupt the new claimant's replay).
      await this.assertClaimEpoch(tx, run_id);

      const result = await tx
        .delete(workflow_events)
        .where(
          and(
            eq(workflow_events.run_id, run_id),
            sql`${workflow_events.sequence_id} <= ${beforeSequenceId}`,
            this.tenantEq(workflow_events.tenant_id),
          )
        )
        .returning({ id: workflow_events.id });

      return result.length;
    });
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────

function fromRow(row: typeof workflow_events.$inferSelect): WorkflowEvent {
  return {
    id: row.id,
    run_id: row.run_id,
    sequence_id: row.sequence_id,
    event_type: row.event_type as WorkflowEvent['event_type'],
    node_id: row.node_id ?? undefined,
    action: row.action ? (row.action as unknown as Action) : undefined,
    internal_type: row.internal_type ?? undefined,
    internal_payload: row.internal_payload
      ? (row.internal_payload as Record<string, unknown>)
      : undefined,
    created_at: row.created_at,
  };
}

function toSerializable(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

/** Postgres unique-constraint violation (SQLSTATE 23505), possibly wrapped. */
function isUniqueViolation(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  const err = error as { code?: string; cause?: unknown };
  if (err.code === '23505') return true;
  return isUniqueViolation(err.cause);
}
