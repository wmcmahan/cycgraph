/**
 * Drizzle Retention Service
 *
 * Implements RetentionService using Drizzle ORM + PostgreSQL.
 */

import { workflow_runs, workflow_states } from './schema.js';
import { and, lt, inArray, isNull, count } from 'drizzle-orm';
import { withPlatform } from './tenancy.js';
import type { RetentionService } from '@cycgraph/orchestrator';

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

    const completedRuns = await db
      .select({ id: workflow_runs.id })
      .from(workflow_runs)
      .where(and(
        inArray(workflow_runs.status, ['completed', 'failed', 'cancelled', 'timeout']),
        lt(workflow_runs.completed_at, cutoff),
        isNull(workflow_runs.archived_at)
      ));

    if (completedRuns.length === 0) {
      return 0;
    }

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

    return completedRuns.length;
    });
  }

  async deleteWarmData(): Promise<number> {
    return withPlatform(async (db) => {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const deleted = await db
      .delete(workflow_states)
      .where(lt(workflow_states.archived_at, cutoff))
      .returning({ id: workflow_states.id });

    return deleted.length;
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

    return {
      hot_runs: hotRuns[0]?.count ?? 0,
      warm_runs: warmRuns[0]?.count ?? 0,
      cold_runs: 0,
    };
    });
  }
}
