/**
 * Drizzle Retention Service
 *
 * Implements RetentionService using Drizzle ORM + PostgreSQL.
 */

import { workflow_runs, workflow_states } from './schema.js';
import { and, lt, inArray, isNull, isNotNull, count } from 'drizzle-orm';
import { withPlatform } from './tenancy.js';
import type { RetentionService } from '@cycgraph/orchestrator';

/** Rows processed per GC transaction, bounding lock duration and `IN (…)` size. */
const RETENTION_BATCH = 1000;

/**
 * Data-lifecycle GC. This is **platform-plane**: it sweeps completed runs
 * across ALL tenants, so every method runs under {@link withPlatform} (no
 * tenant scope) by deliberate design — that is also where a BYPASSRLS
 * connection will be selected once RLS is enforced, since an owner/app role
 * subject to the policies could not see other tenants' rows to archive them.
 */
export class DrizzleRetentionService implements RetentionService {
  async archiveCompletedWorkflows(): Promise<number> {
    return withPlatform(async (db) => {
      const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
      let totalArchived = 0;

      // Batch with LIMIT: the completed-but-unarchived set grows monotonically
      // (runs are archived, not deleted, here), so an unbounded single UPDATE
      // would build a giant IN (…) list and hold a long write transaction.
      for (;;) {
        const completedRuns = await db
          .select({ id: workflow_runs.id })
          .from(workflow_runs)
          .where(and(
            inArray(workflow_runs.status, ['completed', 'failed', 'cancelled', 'timeout']),
            lt(workflow_runs.completed_at, cutoff),
            isNull(workflow_runs.archived_at),
          ))
          .limit(RETENTION_BATCH);

        if (completedRuns.length === 0) break;

        const runIds = completedRuns.map(r => r.id);
        const now = new Date();
        await db.transaction(async (tx) => {
          await tx.update(workflow_runs)
            .set({ archived_at: now })
            .where(inArray(workflow_runs.id, runIds));
          await tx.update(workflow_states)
            .set({ archived_at: now })
            .where(inArray(workflow_states.run_id, runIds));
        });

        totalArchived += completedRuns.length;
        if (completedRuns.length < RETENTION_BATCH) break;
      }

      return totalArchived;
    });
  }

  async deleteWarmData(): Promise<number> {
    return withPlatform(async (db) => {
      const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      let totalDeleted = 0;

      // Delete COLD runs (archived more than the retention window ago). The FK
      // cascade reclaims their workflow_states, workflow_events (the highest-
      // volume table), workflow_checkpoints and usage_records in one shot —
      // previously only workflow_states rows were deleted, so events/usage grew
      // forever. Batched to bound the delete transaction.
      for (;;) {
        const coldRuns = await db
          .select({ id: workflow_runs.id })
          .from(workflow_runs)
          .where(and(
            isNotNull(workflow_runs.archived_at),
            lt(workflow_runs.archived_at, cutoff),
          ))
          .limit(RETENTION_BATCH);

        if (coldRuns.length === 0) break;

        const runIds = coldRuns.map(r => r.id);
        const deleted = await db
          .delete(workflow_runs)
          .where(inArray(workflow_runs.id, runIds))
          .returning({ id: workflow_runs.id });

        totalDeleted += deleted.length;
        if (coldRuns.length < RETENTION_BATCH) break;
      }

      return totalDeleted;
    });
  }

  async getStorageStats(): Promise<{
    hot_runs: number;
    warm_runs: number;
    cold_runs: number;
  }> {
    return withPlatform(async (db) => {
    const hotRuns = await db
      .select({ count: count() })
      .from(workflow_runs)
      .where(inArray(workflow_runs.status, ['pending', 'scheduled', 'running', 'waiting', 'retrying']));

    const warmRuns = await db
      .select({ count: count() })
      .from(workflow_runs)
      .where(and(
        inArray(workflow_runs.status, ['completed', 'failed', 'cancelled', 'timeout']),
        isNull(workflow_runs.archived_at)
      ));

    // Cold = archived (awaiting deletion by deleteWarmData). Previously
    // hardcoded to 0, which hid the archived backlog from operators.
    const coldRuns = await db
      .select({ count: count() })
      .from(workflow_runs)
      .where(isNotNull(workflow_runs.archived_at));

    return {
      hot_runs: hotRuns[0]?.count ?? 0,
      warm_runs: warmRuns[0]?.count ?? 0,
      cold_runs: coldRuns[0]?.count ?? 0,
    };
    });
  }
}
