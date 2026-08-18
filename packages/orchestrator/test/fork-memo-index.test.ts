/**
 * Tests for the memo index and the replay error types: which base-run
 * executions are reusable, which are deliberately not, and what a refusal says.
 */

import { describe, it, expect } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { indexBaseRun, createMemoizer } from '../src/replay/memoize.js';
import { ForkError, ReplayVersionMismatchError, SideEffectBlockedError } from '../src/replay/errors.js';
import { createWorkflowState } from '../src/state/state.js';
import { InMemoryAgentRegistry } from '../src/persistence/in-memory.js';
import type { Graph, GraphNode } from '../src/graph/graph.js';
import type { WorkflowEvent } from '../src/persistence/event.js';
import type { MiddlewareContext } from '../src/execution/middleware/middleware.js';
import type { WorkflowState } from '../src/state/state.js';

const POLICY = { max_retries: 0, backoff_ms: 0, backoff_strategy: 'fixed' as const };
const RUN = '11111111-1111-4111-8111-111111111111';
const WORKFLOW = '22222222-2222-4222-8222-222222222222';
const T0 = new Date('2026-01-01T00:00:00.000Z');

let sequence = 0;

function event(partial: Partial<WorkflowEvent> & Pick<WorkflowEvent, 'event_type'>): WorkflowEvent {
  return { id: uuidv4(), run_id: RUN, sequence_id: sequence++, created_at: T0, ...partial };
}

function started(nodeId: string): WorkflowEvent {
  return event({ event_type: 'node_started', node_id: nodeId });
}

function wrote(nodeId: string, updates: Record<string, unknown>): WorkflowEvent {
  return event({
    event_type: 'action_dispatched',
    node_id: nodeId,
    action: {
      id: uuidv4(),
      idempotency_key: `${nodeId}:0:1`,
      type: 'update_memory',
      payload: { updates },
      metadata: { node_id: nodeId, timestamp: T0, attempt: 1 },
    },
  });
}

function node(id: string, agentId?: string): GraphNode {
  return {
    id, type: 'agent', read_keys: ['seed'], write_keys: [`${id}_out`],
    failure_policy: POLICY, ...(agentId ? { agent_id: agentId } : {}),
  } as GraphNode;
}

function graphOf(...nodes: GraphNode[]): Graph {
  return { id: WORKFLOW, name: 'g', description: 'g', nodes, edges: [], start_node: nodes[0]!.id, end_nodes: [] } as Graph;
}

function seed(): WorkflowState {
  return createWorkflowState({ workflowId: WORKFLOW, runId: RUN, goal: 'g' });
}

function registryWith(name: string): { registry: InMemoryAgentRegistry; id: string } {
  const registry = new InMemoryAgentRegistry();
  const id = registry.register({
    name, model: 'claude-sonnet-4-6', provider: 'anthropic', systemPrompt: name,
  });
  return { registry, id };
}

describe('indexBaseRun', () => {
  it('indexes an execution that produced an action', async () => {
    sequence = 0;
    const { registry, id } = registryWith('A');
    const graph = graphOf(node('a', id));

    const index = await indexBaseRun(graph, [started('a'), wrote('a', { a_out: 1 })], seed(), registry);

    expect(index.size).toBe(1);
    expect([...index.values()][0]![0]!.nodeId).toBe('a');
  });

  it('skips a node that produced no action', async () => {
    sequence = 0;
    const { registry, id } = registryWith('A');
    const graph = graphOf(node('a', id));

    expect((await indexBaseRun(graph, [started('a')], seed(), registry)).size).toBe(0);
  });

  it('skips a node whose next event is another node starting', async () => {
    sequence = 0;
    const { registry, id } = registryWith('A');
    const graph = graphOf(node('a', id), node('b', id));

    const index = await indexBaseRun(
      graph, [started('a'), started('b'), wrote('b', { b_out: 1 })], seed(), registry,
    );

    expect([...index.values()].flat().map(e => e.nodeId)).toEqual(['b']);
  });

  it('skips a node the graph does not have', async () => {
    sequence = 0;
    const { registry, id } = registryWith('A');
    const graph = graphOf(node('a', id));

    const index = await indexBaseRun(
      graph, [started('ghost'), wrote('ghost', { x: 1 })], seed(), registry,
    );

    expect(index.size).toBe(0);
  });

  it('skips a node whose agent cannot be resolved', async () => {
    sequence = 0;
    const { registry } = registryWith('A');
    const graph = graphOf(node('a', 'missing-agent'));

    expect((await indexBaseRun(graph, [started('a'), wrote('a', { a_out: 1 })], seed(), registry)).size)
      .toBe(0);
  });

  it('queues a fingerprint seen twice in recorded order', async () => {
    sequence = 0;
    const { registry, id } = registryWith('A');
    const graph = graphOf(node('a', id));

    const index = await indexBaseRun(graph, [
      started('a'), wrote('a', { a_out: 'first' }),
      started('a'), wrote('a', { a_out: 'second' }),
    ], seed(), registry);

    const queue = [...index.values()][0]!;
    expect(queue.map(e => (e.action.payload as { updates: { a_out: string } }).updates.a_out))
      .toEqual(['first', 'second']);
  });

  it('excludes executions before the fork boundary from the queue', async () => {
    sequence = 0;
    const { registry, id } = registryWith('A');
    const graph = graphOf(node('a', id));
    const events = [
      started('a'), wrote('a', { a_out: 'first' }),
      started('a'), wrote('a', { a_out: 'second' }),
    ];
    const boundary = events[2]!.sequence_id;

    const index = await indexBaseRun(graph, events, seed(), registry, { fromSequenceId: boundary });

    const queue = [...index.values()][0]!;
    expect(queue.map(e => (e.action.payload as { updates: { a_out: string } }).updates.a_out))
      .toEqual(['second']);
  });

  it('keeps distinct executions whose inputs differ', async () => {
    sequence = 0;
    const { registry, id } = registryWith('A');
    const graph = graphOf(node('a', id), node('b', id));

    const index = await indexBaseRun(graph, [
      started('a'), wrote('a', { seed: 'x' }),
      started('b'), wrote('b', { b_out: 1 }),
    ], seed(), registry);

    expect(index.size).toBe(2);
  });
});

describe('createMemoizer', () => {
  it('serves a node whose fingerprint matches the index', async () => {
    sequence = 0;
    const { registry, id } = registryWith('A');
    const graph = graphOf(node('a', id));
    const events = [started('a'), wrote('a', { a_out: 'recorded' })];
    const index = await indexBaseRun(graph, events, seed(), registry);

    const memo = createMemoizer({ index, graph, registry });
    const result = await memo.middleware.beforeNodeExecute!({
      node: graph.nodes[0]!, state: seed(), graph, iteration: 0,
    } as MiddlewareContext);

    expect(result?.shortCircuit?.payload).toEqual({ updates: { a_out: 'recorded' } });
    expect(memo.hits.map(h => h.nodeId)).toEqual(['a']);
  });

  it('lets a node execute when its inputs differ from the recording', async () => {
    sequence = 0;
    const { registry, id } = registryWith('A');
    const graph = graphOf(node('a', id));
    const index = await indexBaseRun(graph, [started('a'), wrote('a', { a_out: 1 })], seed(), registry);

    const memo = createMemoizer({ index, graph, registry });
    const changed = { ...seed(), memory: { seed: 'different' } };
    const result = await memo.middleware.beforeNodeExecute!({
      node: graph.nodes[0]!, state: changed, graph, iteration: 0,
    } as MiddlewareContext);

    expect(result).toBeUndefined();
    expect(memo.hits).toEqual([]);
  });

  it('lets a node with an unresolvable agent execute', async () => {
    sequence = 0;
    const { registry, id } = registryWith('A');
    const graph = graphOf(node('a', id));
    const index = await indexBaseRun(graph, [started('a'), wrote('a', { a_out: 1 })], seed(), registry);

    const memo = createMemoizer({ index, graph, registry });
    const result = await memo.middleware.beforeNodeExecute!({
      node: node('a', 'ghost'), state: seed(), graph, iteration: 0,
    } as MiddlewareContext);

    expect(result).toBeUndefined();
  });

  it('serves repeated executions in recorded order', async () => {
    sequence = 0;
    const { registry, id } = registryWith('A');
    const graph = graphOf(node('a', id));
    const index = await indexBaseRun(graph, [
      started('a'), wrote('a', { a_out: 'first' }),
      started('a'), wrote('a', { a_out: 'second' }),
    ], seed(), registry);

    const memo = createMemoizer({ index, graph, registry });
    const ctx = { node: graph.nodes[0]!, state: seed(), graph, iteration: 0 } as MiddlewareContext;
    const first = await memo.middleware.beforeNodeExecute!(ctx);
    const second = await memo.middleware.beforeNodeExecute!(ctx);

    expect(first?.shortCircuit?.payload).toEqual({ updates: { a_out: 'first' } });
    expect(second?.shortCircuit?.payload).toEqual({ updates: { a_out: 'second' } });
  });

  it('lets a visit beyond the recorded count run live', async () => {
    sequence = 0;
    const { registry, id } = registryWith('A');
    const graph = graphOf(node('a', id));
    const index = await indexBaseRun(graph, [
      started('a'), wrote('a', { a_out: 'only' }),
    ], seed(), registry);

    const memo = createMemoizer({ index, graph, registry });
    const ctx = { node: graph.nodes[0]!, state: seed(), graph, iteration: 0 } as MiddlewareContext;
    await memo.middleware.beforeNodeExecute!(ctx);
    const exhausted = await memo.middleware.beforeNodeExecute!(ctx);

    expect(exhausted).toBeUndefined();
    expect(memo.hits).toHaveLength(1);
  });

  it('gives each memoizer its own consumption of a shared index', async () => {
    sequence = 0;
    const { registry, id } = registryWith('A');
    const graph = graphOf(node('a', id));
    const index = await indexBaseRun(graph, [
      started('a'), wrote('a', { a_out: 'first' }),
    ], seed(), registry);

    const ctx = { node: graph.nodes[0]!, state: seed(), graph, iteration: 0 } as MiddlewareContext;
    const one = createMemoizer({ index, graph, registry });
    const two = createMemoizer({ index, graph, registry });
    await one.middleware.beforeNodeExecute!(ctx);
    const fresh = await two.middleware.beforeNodeExecute!(ctx);

    expect(fresh?.shortCircuit?.payload).toEqual({ updates: { a_out: 'first' } });
  });

  it('reports how many executions it indexed', async () => {
    sequence = 0;
    const { registry, id } = registryWith('A');
    const graph = graphOf(node('a', id));
    const index = await indexBaseRun(graph, [started('a'), wrote('a', { a_out: 1 })], seed(), registry);

    expect(createMemoizer({ index, graph, registry }).size).toBe(1);
  });
});

describe('replay errors', () => {
  it('ForkError carries its message and name', () => {
    const error = new ForkError('nothing to fork');

    expect(error.name).toBe('ForkError');
    expect(error.message).toBe('nothing to fork');
  });

  it('ReplayVersionMismatchError names both versions and the run', () => {
    const error = new ReplayVersionMismatchError(RUN, 1, 3);

    expect(error.name).toBe('ReplayVersionMismatchError');
    expect(error.runId).toBe(RUN);
    expect(error.loggedVersion).toBe(1);
    expect(error.currentVersion).toBe(3);
    expect(error.message).toContain('recorded under replay version 1');
    expect(error.message).toContain('now implement version 3');
  });

  it('SideEffectBlockedError names the node, its type, and both ways out', () => {
    const error = new SideEffectBlockedError('fetch', 'tool', 'no recorded result');

    expect(error.name).toBe('SideEffectBlockedError');
    expect(error.nodeId).toBe('fetch');
    expect(error.nodeType).toBe('tool');
    expect(error.message).toContain('no recorded result');
    expect(error.message).toContain('policy.sideEffects');
    expect(error.message).toContain('fork at a point where its inputs are unchanged');
  });
});
