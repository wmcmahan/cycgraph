/**
 * DrizzleRetentionService Tests
 *
 * Integration tests for the data-lifecycle GC (archive → delete) and the
 * hot/warm/cold storage stats. Skipped automatically when DATABASE_URL is
 * not set.
 */

import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { setupDatabaseTests, isDatabaseAvailable, getDb } from './setup.js';
import { DrizzleRetentionService } from '../src/drizzle-retention.js';
import { DrizzlePersistenceProvider } from '../src/drizzle-persistence.js';
import { createWorkflowState, createGraph } from '@cycgraph/orchestrator';
import { workflow_runs, workflow_states } from '../src/schema.js';

describe.skipIf(!isDatabaseAvailable())('DrizzleRetentionService', () => {
  setupDatabaseTests();

  const retention = new DrizzleRetentionService();
  const persistence = new DrizzlePersistenceProvider();

  async function createWorkflow(status: 'running' | 'completed', completedAt?: Date) {
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

    const state = createWorkflowState({ workflow_id: graph.id, goal: 'Test', status });
    await persistence.saveWorkflowRun(state);
    await persistence.saveWorkflowState(state);

    if (completedAt) {
      const db = await getDb();
      await db.update(workflow_runs)
        .set({ completed_at: completedAt })
        .where(eq(workflow_runs.id, state.run_id));
    }

    return state;
  }

  async function makeCold(runId: string) {
    const db = await getDb();
    await db.update(workflow_runs)
      .set({ archived_at: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000) })
      .where(eq(workflow_runs.id, runId));
  }

  describe('archiveCompletedWorkflows', () => {
    it('archives workflows completed more than 24h ago', async () => {
      await createWorkflow('completed', new Date(Date.now() - 48 * 60 * 60 * 1000));

      const archived = await retention.archiveCompletedWorkflows();

      expect(archived).toBeGreaterThanOrEqual(1);
    });

    it('does not archive recently completed workflows', async () => {
      await createWorkflow('completed', new Date(Date.now() - 60 * 60 * 1000));

      const archived = await retention.archiveCompletedWorkflows();

      expect(archived).toBe(0);
    });

    it('returns 0 when there is nothing to archive', async () => {
      expect(await retention.archiveCompletedWorkflows()).toBe(0);
    });
  });

  describe('deleteWarmData', () => {
    it('deletes cold runs and cascades to their state rows', async () => {
      const state = await createWorkflow('completed', new Date(Date.now() - 48 * 60 * 60 * 1000));
      await retention.archiveCompletedWorkflows();
      await makeCold(state.run_id);

      const deleted = await retention.deleteWarmData();

      expect(deleted).toBeGreaterThanOrEqual(1);
      const db = await getDb();
      const run = await db.select().from(workflow_runs).where(eq(workflow_runs.id, state.run_id));
      expect(run).toHaveLength(0);
      const states = await db.select().from(workflow_states).where(eq(workflow_states.run_id, state.run_id));
      expect(states).toHaveLength(0);
    });

    it('does not delete runs still within the retention window', async () => {
      const state = await createWorkflow('completed', new Date(Date.now() - 48 * 60 * 60 * 1000));
      await retention.archiveCompletedWorkflows();

      await retention.deleteWarmData();

      const db = await getDb();
      const run = await db.select().from(workflow_runs).where(eq(workflow_runs.id, state.run_id));
      expect(run).toHaveLength(1);
    });

    it('returns 0 when there is nothing to delete', async () => {
      expect(await retention.deleteWarmData()).toBe(0);
    });
  });

  describe('getStorageStats', () => {
    it('returns zero counts when empty', async () => {
      const stats = await retention.getStorageStats();

      expect(stats.hot_runs).toBe(0);
      expect(stats.warm_runs).toBe(0);
      expect(stats.cold_runs).toBe(0);
    });

    it('counts a running workflow as hot', async () => {
      await createWorkflow('running');

      const stats = await retention.getStorageStats();

      expect(stats.hot_runs).toBeGreaterThanOrEqual(1);
    });

    it('counts a completed unarchived workflow as warm', async () => {
      await createWorkflow('completed', new Date(Date.now() - 48 * 60 * 60 * 1000));

      const stats = await retention.getStorageStats();

      expect(stats.warm_runs).toBeGreaterThanOrEqual(1);
      expect(stats.cold_runs).toBe(0);
    });

    it('counts an archived workflow as cold', async () => {
      await createWorkflow('completed', new Date(Date.now() - 48 * 60 * 60 * 1000));
      await retention.archiveCompletedWorkflows();

      const stats = await retention.getStorageStats();

      expect(stats.cold_runs).toBeGreaterThanOrEqual(1);
    });
  });
});
