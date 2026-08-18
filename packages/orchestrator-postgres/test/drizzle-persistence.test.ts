/**
 * Tests for `drizzle-persistence.ts` — the Postgres-backed PersistenceProvider
 * and the `toWorkflowStateJson` serialization helper.
 */

import { describe, it, expect } from 'vitest';
import { setupDatabaseTests, isDatabaseAvailable, seedRun } from './setup.js';
import { DrizzlePersistenceProvider, toWorkflowStateJson } from '../src/drizzle-persistence.js';
import { DrizzleEventLogWriter } from '../src/drizzle-event-log.js';
import { createWorkflowState, createGraph } from '@cycgraph/orchestrator';
import type { WorkflowState } from '@cycgraph/orchestrator';

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

describe('toWorkflowStateJson', () => {
  it('copies the identity and goal fields through unchanged', () => {
    const workflowId = crypto.randomUUID();
    const state = createWorkflowState({ workflow_id: workflowId, goal: 'do the thing' });

    const json = toWorkflowStateJson(state);

    expect(json.workflow_id).toBe(workflowId);
    expect(json.run_id).toBe(state.run_id);
    expect(json.goal).toBe('do the thing');
    expect(json.status).toBe(state.status);
  });

  it('carries the security-critical registries so they survive a round-trip', () => {
    const state = createWorkflowState({ workflow_id: crypto.randomUUID(), goal: 'g', budget_usd: 5 });

    const json = toWorkflowStateJson(state);

    expect(json.budget_usd).toBe(5);
    expect('taint_registry' in json).toBe(true);
    expect('lesson_provenance' in json).toBe(true);
    expect('state_schema_version' in json).toBe(true);
  });
});

describe.skipIf(!isDatabaseAvailable())('DrizzlePersistenceProvider', () => {
  setupDatabaseTests();

  const provider = new DrizzlePersistenceProvider();

  function makeGraph(id?: string) {
    return createGraph({
      id,
      name: 'Test Graph',
      description: 'A test graph',
      nodes: [
        {
          id: 'start',
          type: 'agent',
          agent_id: 'agent-1',
          read_keys: ['*'],
          write_keys: ['*'],
        },
      ],
      edges: [],
      start_node: 'start',
      end_nodes: ['start'],
    });
  }

  function makeState(graphId: string, overrides: Partial<WorkflowState> = {}): WorkflowState {
    return createWorkflowState({
      workflow_id: graphId,
      goal: 'Test goal',
      ...overrides,
    });
  }

  describe('saveGraph / loadGraph', () => {
    it('saves and loads a graph', async () => {
      const graph = makeGraph();
      await provider.saveGraph(graph);

      const loaded = await provider.loadGraph(graph.id);

      expect(loaded).not.toBeNull();
      expect(loaded!.name).toBe('Test Graph');
      expect(loaded!.start_node).toBe('start');
    });

    it('returns null for a non-existent graph', async () => {
      const loaded = await provider.loadGraph(NIL_UUID);

      expect(loaded).toBeNull();
    });

    it('upserts on a duplicate graph id', async () => {
      const graph = makeGraph();
      await provider.saveGraph(graph);

      await provider.saveGraph({ ...graph, name: 'Updated Graph' });

      const loaded = await provider.loadGraph(graph.id);
      expect(loaded!.name).toBe('Updated Graph');
    });
  });

  describe('listGraphs', () => {
    it('lists graphs ordered by updated_at descending', async () => {
      const g1 = makeGraph();
      const g2 = makeGraph();
      await provider.saveGraph(g1);
      await new Promise(r => setTimeout(r, 10));
      await provider.saveGraph(g2);

      const list = await provider.listGraphs({ limit: 10 });

      expect(list.length).toBeGreaterThanOrEqual(2);
      expect(list[0].id).toBe(g2.id);
    });
  });

  describe('deleteGraph', () => {
    it('deletes an existing graph and returns true', async () => {
      const graph = makeGraph();
      await provider.saveGraph(graph);

      const deleted = await provider.deleteGraph(graph.id);

      expect(deleted).toBe(true);
      expect(await provider.loadGraph(graph.id)).toBeNull();
    });

    it('returns false when no graph matched', async () => {
      const deleted = await provider.deleteGraph(NIL_UUID);

      expect(deleted).toBe(false);
    });
  });

  describe('saveWorkflowRun / loadWorkflowRun', () => {
    it('saves and loads a workflow run', async () => {
      const graph = makeGraph();
      await provider.saveGraph(graph);
      const state = makeState(graph.id);

      await provider.saveWorkflowRun(state);
      const loaded = await provider.loadWorkflowRun(state.run_id);

      expect(loaded).not.toBeNull();
      expect(loaded!.status).toBe('pending');
      expect(loaded!.graph_id).toBe(graph.id);
    });

    it('returns null for a non-existent run', async () => {
      const loaded = await provider.loadWorkflowRun(NIL_UUID);

      expect(loaded).toBeNull();
    });

    it('stamps completed_at when saving a terminal run', async () => {
      const graph = makeGraph();
      await provider.saveGraph(graph);
      const state = makeState(graph.id, { status: 'completed' });

      await provider.saveWorkflowRun(state);
      const loaded = await provider.loadWorkflowRun(state.run_id);

      expect(loaded!.status).toBe('completed');
      expect(loaded!.completed_at).toBeInstanceOf(Date);
    });
  });

  describe('listWorkflowRuns', () => {
    it('lists runs ordered by created_at descending', async () => {
      const graph = makeGraph();
      await provider.saveGraph(graph);
      const first = makeState(graph.id);
      await provider.saveWorkflowRun(first);
      await new Promise(r => setTimeout(r, 10));
      const second = makeState(graph.id);
      await provider.saveWorkflowRun(second);

      const runs = await provider.listWorkflowRuns({ limit: 10 });

      expect(runs.length).toBeGreaterThanOrEqual(2);
      expect(runs[0].id).toBe(second.run_id);
    });
  });

  describe('updateRunStatus', () => {
    it('updates the status and returns the affected row count', async () => {
      const graph = makeGraph();
      await provider.saveGraph(graph);
      const state = makeState(graph.id);
      await provider.saveWorkflowRun(state);

      const updated = await provider.updateRunStatus(state.run_id, 'running');

      expect(updated).toBe(1);
      expect((await provider.loadWorkflowRun(state.run_id))!.status).toBe('running');
    });

    it('stamps completed_at when transitioning to a terminal status', async () => {
      const graph = makeGraph();
      await provider.saveGraph(graph);
      const state = makeState(graph.id);
      await provider.saveWorkflowRun(state);

      await provider.updateRunStatus(state.run_id, 'completed');

      const loaded = await provider.loadWorkflowRun(state.run_id);
      expect(loaded!.status).toBe('completed');
      expect(loaded!.completed_at).toBeInstanceOf(Date);
    });

    it('returns 0 when no run matched', async () => {
      const updated = await provider.updateRunStatus(NIL_UUID, 'running');

      expect(updated).toBe(0);
    });
  });

  describe('saveWorkflowState / loadLatestWorkflowState', () => {
    it('saves and loads the latest state', async () => {
      const graph = makeGraph();
      await provider.saveGraph(graph);
      const state = makeState(graph.id);
      await provider.saveWorkflowRun(state);

      await provider.saveWorkflowState(state);
      const loaded = await provider.loadLatestWorkflowState(state.run_id);

      expect(loaded).not.toBeNull();
      expect(loaded!.workflow_id).toBe(graph.id);
      expect(loaded!.goal).toBe('Test goal');
    });

    it('returns null for a non-existent run', async () => {
      const loaded = await provider.loadLatestWorkflowState(NIL_UUID);

      expect(loaded).toBeNull();
    });

    it('returns the highest version regardless of created_at ordering', async () => {
      const graph = makeGraph();
      await provider.saveGraph(graph);
      const state1 = makeState(graph.id);
      await provider.saveWorkflowRun(state1);

      await provider.saveWorkflowState(state1);
      await provider.saveWorkflowState({ ...state1, memory: { step: 'second' } });

      const loaded = await provider.loadLatestWorkflowState(state1.run_id);
      expect(loaded!.memory?.step).toBe('second');
    });
  });

  describe('saveWorkflowSnapshot', () => {
    it('creates the run and the first state version atomically', async () => {
      const graph = makeGraph();
      await provider.saveGraph(graph);
      const state = makeState(graph.id);

      await provider.saveWorkflowSnapshot(state);

      expect(await provider.loadWorkflowRun(state.run_id)).not.toBeNull();
      const loaded = await provider.loadLatestWorkflowState(state.run_id);
      expect(loaded!.goal).toBe('Test goal');
    });
  });

  describe('loadWorkflowStateHistory', () => {
    it('returns state versions in ascending order', async () => {
      const graph = makeGraph();
      await provider.saveGraph(graph);
      const state = makeState(graph.id);
      await provider.saveWorkflowRun(state);

      await provider.saveWorkflowState(state);
      await provider.saveWorkflowState({ ...state, status: 'running' as const });
      await provider.saveWorkflowState({ ...state, status: 'completed' as const });

      const history = await provider.loadWorkflowStateHistory(state.run_id);

      expect(history).toHaveLength(3);
      expect(history[0].version).toBe(1);
      expect(history[2].version).toBe(3);
    });
  });

  describe('loadWorkflowStateAtVersion', () => {
    it('returns the specific requested version', async () => {
      const graph = makeGraph();
      await provider.saveGraph(graph);
      const state = makeState(graph.id);
      await provider.saveWorkflowRun(state);

      await provider.saveWorkflowState(state);
      await provider.saveWorkflowState({ ...state, memory: { version: 'two' } });

      const v1 = await provider.loadWorkflowStateAtVersion(state.run_id, 1);
      const v2 = await provider.loadWorkflowStateAtVersion(state.run_id, 2);

      expect(v1).not.toBeNull();
      expect(v2).not.toBeNull();
      expect(v2!.memory?.version).toBe('two');
    });

    it('returns null for a non-existent version', async () => {
      const result = await provider.loadWorkflowStateAtVersion(NIL_UUID, 999);

      expect(result).toBeNull();
    });
  });

  describe('loadEvents', () => {
    it('loads a run\'s events ordered by sequence id', async () => {
      const runId = await seedRun(crypto.randomUUID());
      const writer = new DrizzleEventLogWriter();
      await writer.append({ run_id: runId, sequence_id: 0, event_type: 'workflow_started' });
      await writer.append({ run_id: runId, sequence_id: 1, event_type: 'node_started', node_id: 'start' });

      const events = await provider.loadEvents(runId);

      expect(events).toHaveLength(2);
      expect(events[0].sequence_id).toBe(0);
      expect(events[1].sequence_id).toBe(1);
    });

    it('returns an empty array for a run with no events', async () => {
      const events = await provider.loadEvents(crypto.randomUUID());

      expect(events).toEqual([]);
    });
  });
});

describe.skipIf(!isDatabaseAvailable())('DrizzlePersistenceProvider — fork lineage', () => {
  setupDatabaseTests();

  const provider = new DrizzlePersistenceProvider();

  it('defaults an ordinary run to the primary kind', async () => {
    const runId = crypto.randomUUID();
    await seedRun(runId);

    expect(await provider.loadWorkflowRun(runId)).toMatchObject({
      run_kind: 'primary',
      fork_sequence_id: null,
      fork_mutations: null,
      fork_group_id: null,
    });
  });

  it('stamps a fork with its parent, divergence point and changes', async () => {
    const baseRunId = crypto.randomUUID();
    const forkRunId = crypto.randomUUID();
    await seedRun(baseRunId);
    await seedRun(forkRunId);

    await provider.saveRunLineage(forkRunId, {
      kind: 'counterfactual',
      parent_run_id: baseRunId,
      fork_sequence_id: 47,
      fork_mutations: [{ kind: 'model', target: 'write', model: 'claude-opus-5' }],
    });

    expect(await provider.loadWorkflowRun(forkRunId)).toMatchObject({
      run_kind: 'counterfactual',
      parent_run_id: baseRunId,
      fork_sequence_id: 47,
      fork_mutations: [{ kind: 'model', target: 'write', model: 'claude-opus-5' }],
    });
  });

  it('groups a sweep of variants under one fork group', async () => {
    const baseRunId = crypto.randomUUID();
    const groupId = crypto.randomUUID();
    await seedRun(baseRunId);

    const variants = [crypto.randomUUID(), crypto.randomUUID()];
    for (const runId of variants) {
      await seedRun(runId);
      await provider.saveRunLineage(runId, {
        kind: 'counterfactual',
        parent_run_id: baseRunId,
        fork_sequence_id: 12,
        fork_mutations: [],
        fork_group_id: groupId,
      });
    }

    const rows = await Promise.all(variants.map((id) => provider.loadWorkflowRun(id)));
    expect(rows.map((r) => r?.fork_group_id)).toEqual([groupId, groupId]);
  });

  it('rejects a run kind the engine does not know', async () => {
    const runId = crypto.randomUUID();
    await seedRun(runId);

    await expect(provider.saveRunLineage(runId, {
      kind: 'bogus' as 'counterfactual',
      parent_run_id: runId,
      fork_sequence_id: 0,
      fork_mutations: [],
    })).rejects.toThrow();
  });

  it('leaves lineage intact when the run row is saved again', async () => {
    const baseRunId = crypto.randomUUID();
    const forkRunId = crypto.randomUUID();
    await seedRun(baseRunId);
    await seedRun(forkRunId);
    await provider.saveRunLineage(forkRunId, {
      kind: 'counterfactual',
      parent_run_id: baseRunId,
      fork_sequence_id: 3,
      fork_mutations: [],
    });

    const state = createWorkflowState({ workflow_id: crypto.randomUUID(), goal: 'g' });
    await provider.saveWorkflowRun({ ...state, run_id: forkRunId, status: 'completed' } as WorkflowState);

    expect(await provider.loadWorkflowRun(forkRunId)).toMatchObject({
      run_kind: 'counterfactual',
      parent_run_id: baseRunId,
      status: 'completed',
    });
  });
});
