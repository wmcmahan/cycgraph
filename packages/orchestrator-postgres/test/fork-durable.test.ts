/**
 * Integration tests for forking against the Postgres adapter: the variant's
 * events, row, and lineage all land durably, in an order the foreign keys
 * accept. Skipped automatically when DATABASE_URL is not set.
 */

import { describe, it, expect } from 'vitest';
import { setupDatabaseTests, isDatabaseAvailable } from './setup.js';
import { DrizzlePersistenceProvider } from '../src/drizzle-persistence.js';
import { DrizzleEventLogWriter } from '../src/drizzle-event-log.js';
import {
  fork,
  change,
  createGraph,
  createWorkflowState,
  GraphRunner,
  InMemoryAgentRegistry,
} from '@cycgraph/orchestrator';
import type { Graph } from '@cycgraph/orchestrator';

describe.skipIf(!isDatabaseAvailable())('fork against Postgres', () => {
  setupDatabaseTests();

  const persistence = new DrizzlePersistenceProvider();
  const eventLog = new DrizzleEventLogWriter();

  async function recordBase(): Promise<{ graph: Graph; runId: string; registry: InMemoryAgentRegistry }> {
    const registry = new InMemoryAgentRegistry();
    const graph = createGraph({
      name: 'pg-fork-base',
      description: 'durable fork fixture',
      nodes: [
        { id: 'seed', type: 'tool', toolId: 'emit', tools: ['emit'], readKeys: ['goal'] },
        { id: 'branch', type: 'router', readKeys: ['seed_result'] },
        { id: 'low', type: 'tool', toolId: 'emit', tools: ['emit'], readKeys: [] },
        { id: 'high', type: 'tool', toolId: 'emit', tools: ['emit'], readKeys: [] },
      ],
      edges: [
        { source: 'seed', target: 'branch' },
        {
          source: 'branch',
          target: 'high',
          condition: { type: 'conditional', condition: 'memory.seed_result.score >= 0.5' },
        },
        { source: 'branch', target: 'low' },
      ],
      startNode: 'seed',
      endNodes: ['low', 'high'],
    });

    const state = createWorkflowState({ workflowId: graph.id, goal: 'durable fork' });
    await persistence.saveGraph(graph);
    await persistence.saveWorkflowRun(state);

    const runner = new GraphRunner(graph, state, {
      registry,
      eventLog,
      compactionInterval: 0,
      tools: [{
        name: 'emit',
        description: 'emits a fixed score',
        taints: false,
        parameters: { type: 'object', properties: {} },
        execute: async () => ({ score: 0.2 }),
      }],
      persistState: (s) => persistence.saveWorkflowSnapshot(s),
    });
    await runner.run();

    return { graph, runId: state.run_id, registry };
  }

  it('writes the variant durably: row before events, lineage, terminal status', async () => {
    const base = await recordBase();

    const f = await fork(base.runId, {
      at: { beforeNode: 'branch' },
      change: change.memory({ set: { seed_result: { score: 0.9 } } }),
      eventLog,
      persistence,
      registry: base.registry,
      policy: { sideEffects: { allow: ['high', 'low'] } },
      runner: {
        tools: [{
          name: 'emit',
          description: 'emits a fixed score',
          taints: false,
          parameters: { type: 'object', properties: {} },
          execute: async () => ({ score: 0.9 }),
        }],
      },
    });

    expect(f.state?.status).toBe('completed');
    expect(f.state?.visited_nodes).toContain('high');

    const row = await persistence.loadWorkflowRun(f.runId);
    expect(row).toMatchObject({
      run_kind: 'counterfactual',
      parent_run_id: base.runId,
      fork_sequence_id: f.forkSequenceId,
      status: 'completed',
    });

    // The variant defaulted into the durable log, so its history survives the
    // process: genesis at 0, live events above it, no sequence collisions.
    const events = await eventLog.loadEvents(f.runId);
    expect(events[0]).toMatchObject({ sequence_id: 0, event_type: 'workflow_started' });
    expect(events.length).toBeGreaterThan(1);
  });

  it('recovers the durable variant through the ordinary recovery path', async () => {
    const base = await recordBase();

    const f = await fork(base.runId, {
      at: { beforeNode: 'branch' },
      eventLog,
      persistence,
      registry: base.registry,
    });

    const recovered = await GraphRunner.recover(base.graph, f.runId, eventLog, {
      registry: base.registry,
    });

    expect(recovered['state'].status).toBe(f.state?.status);
    expect(recovered['state'].memory).toEqual(f.state?.memory);
  });

  it('marks the row failed when the tail is blocked', async () => {
    const base = await recordBase();

    await expect(fork(base.runId, {
      at: { beforeNode: 'branch' },
      change: change.memory({ set: { seed_result: { score: 0.9 } } }),
      eventLog,
      persistence,
      registry: base.registry,
      // The tail diverges to `high`, which the base never ran, and nothing
      // allows it — so the guard throws and the row must not stay 'running'.
    })).rejects.toThrow(/side effect/);

    const rows = await persistence.listWorkflowRuns({ limit: 20 });
    const orphan = rows.find(r => r.run_kind === 'counterfactual' && r.parent_run_id === base.runId);
    expect(orphan?.status).toBe('failed');
  });
});
