/**
 * DrizzleRetentionService Tests
 *
 * Integration tests for the retention lifecycle.
 * Validates Week 1 fix 1.3 (transactional archiving).
 */

import { describe, test, expect } from 'vitest';
import { setupDatabaseTests, isDatabaseAvailable } from './setup.js';
import { DrizzleRetentionService } from '../src/drizzle-retention.js';
import { DrizzlePersistenceProvider } from '../src/drizzle-persistence.js';
import { createWorkflowState, createGraph } from '@cycgraph/orchestrator';
import { getDb } from './setup.js';
import { workflow_runs, workflow_states } from '../src/schema.js';
import { eq } from 'drizzle-orm';

describe.skipIf(!isDatabaseAvailable())('DrizzleRetentionService', () => {
  setupDatabaseTests();

  const retention = new DrizzleRetentionService();
  const persistence = new DrizzlePersistenceProvider();

  async function createCompletedWorkflow(completedAt: Date) {
    const graph = createGraph({
      name: 'Test',
      description: 'Test',
      nodes: [{
        id: 'start',
        type: 'agent',
        agent_id: 'a1',
        read_keys: ['*'],
        write_keys: ['*'],
      }],
      edges: [],
      start_node: 'start',
      end_nodes: ['start'],
    });
    await persistence.saveGraph(graph);

    const state = createWorkflowState({
      workflow_id: graph.id,
      goal: 'Test',
      status: 'completed',
    });

    await persistence.saveWorkflowRun(state);
    await persistence.saveWorkflowState(state);

    // Backdate the completed_at to make it eligible for archiving
    const db = await getDb();
    await db.update(workflow_runs)
      .set({ completed_at: completedAt })
      .where(eq(workflow_runs.id, state.run_id));

    return state;
  }

  describe('archiveCompletedWorkflows', () => {
    test('should archive workflows completed more than 24h ago', async () => {
      const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
      await createCompletedWorkflow(twoDaysAgo);

      const archived = await retention.archiveCompletedWorkflows();
      expect(archived).toBeGreaterThanOrEqual(1);
    });

    test('should not archive recent workflows', async () => {
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      await createCompletedWorkflow(oneHourAgo);

      const archived = await retention.archiveCompletedWorkflows();
      expect(archived).toBe(0);
    });

    test('should return 0 when no workflows to archive', async () => {
      const archived = await retention.archiveCompletedWorkflows();
      expect(archived).toBe(0);
    });
  });

  describe('deleteWarmData', () => {
    test('deletes cold (archived) runs and cascades to their state rows', async () => {
      const state = await createCompletedWorkflow(new Date(Date.now() - 48 * 60 * 60 * 1000));
      await retention.archiveCompletedWorkflows();

      // Backdate archived_at past the 30-day cold cutoff so the run is eligible.
      const db = await getDb();
      await db.update(workflow_runs)
        .set({ archived_at: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000) })
        .where(eq(workflow_runs.id, state.run_id));

      const deleted = await retention.deleteWarmData();
      expect(deleted).toBeGreaterThanOrEqual(1);

      // The run row is gone, and the FK cascade removed its state snapshots
      // (and, in production, its events/checkpoints/usage_records).
      const run = await db.select().from(workflow_runs).where(eq(workflow_runs.id, state.run_id));
      expect(run).toHaveLength(0);
      const states = await db.select().from(workflow_states).where(eq(workflow_states.run_id, state.run_id));
      expect(states).toHaveLength(0);
    });

    test('does not delete runs still within the retention window', async () => {
      const state = await createCompletedWorkflow(new Date(Date.now() - 48 * 60 * 60 * 1000));
      await retention.archiveCompletedWorkflows(); // archived_at = now (not cold yet)

      await retention.deleteWarmData();

      const db = await getDb();
      const run = await db.select().from(workflow_runs).where(eq(workflow_runs.id, state.run_id));
      expect(run).toHaveLength(1); // freshly-archived run survives
    });
  });

  describe('getStorageStats', () => {
    test('should return stats with zero counts when empty', async () => {
      const stats = await retention.getStorageStats();
      expect(stats.hot_runs).toBe(0);
      expect(stats.warm_runs).toBe(0);
      expect(stats.cold_runs).toBe(0);
    });

    test('counts archived runs as cold (no longer hardcoded 0)', async () => {
      await createCompletedWorkflow(new Date(Date.now() - 48 * 60 * 60 * 1000));
      await retention.archiveCompletedWorkflows();

      const stats = await retention.getStorageStats();
      expect(stats.cold_runs).toBeGreaterThanOrEqual(1);
    });
  });
});
