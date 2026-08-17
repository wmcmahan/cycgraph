/**
 * Unit tests for the fork substrate that the end-to-end fork tests only reach
 * along one path: the execution-time change middleware, canonical comparison,
 * tail cost estimation, and the side-effect guard's policy branches.
 */

import { describe, it, expect } from 'vitest';
import { createChangeMiddleware, hasExecutionTimeChanges } from '../src/replay/change-middleware.js';
import { canonicalJson, canonicalEquals } from '../src/replay/canonical.js';
import { estimateTailCost, formatEstimate } from '../src/replay/estimate.js';
import { createForkGuard } from '../src/replay/fork-guard.js';
import { change } from '../src/replay/mutations.js';
import { SideEffectBlockedError } from '../src/replay/errors.js';
import { createWorkflowState } from '../src/state/state.js';
import type { Graph, GraphNode } from '../src/graph/graph.js';
import type { MiddlewareContext } from '../src/execution/middleware/middleware.js';
import type { WorkflowState } from '../src/state/state.js';
import type { WorkflowEvent } from '../src/persistence/event.js';

const POLICY = { max_retries: 0, backoff_ms: 0, backoff_strategy: 'fixed' as const };
const WORKFLOW = '22222222-2222-4222-8222-222222222222';

function node(id: string, type: GraphNode['type'] = 'agent', extra: Partial<GraphNode> = {}): GraphNode {
  return { id, type, read_keys: [], write_keys: [], failure_policy: POLICY, ...extra } as GraphNode;
}

function graphOf(...nodes: GraphNode[]): Graph {
  return { id: 'g', name: 'g', description: 'g', nodes, edges: [], start_node: nodes[0]!.id, end_nodes: [] } as Graph;
}

function ctx(n: GraphNode, state: WorkflowState): MiddlewareContext {
  return { node: n, state, graph: graphOf(n), iteration: state.iteration_count };
}

function stateWith(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return { ...createWorkflowState({ workflowId: WORKFLOW, goal: 'g' }), ...overrides };
}

describe('hasExecutionTimeChanges', () => {
  it('is true for the changes that fire from middleware', () => {
    expect(hasExecutionTimeChanges([change.output('n', {})])).toBe(true);
    expect(hasExecutionTimeChanges([change.tool('n', 1)])).toBe(true);
    expect(hasExecutionTimeChanges([change.route('a', 'b')])).toBe(true);
  });

  it('is false for changes applied before the tail starts', () => {
    expect(hasExecutionTimeChanges([change.memory({ set: {} }), change.model('n', 'm')]))
      .toBe(false);
  });

  it('is false for an empty set', () => {
    expect(hasExecutionTimeChanges([])).toBe(false);
  });
});

describe('createChangeMiddleware — output substitution', () => {
  it('short-circuits the named node with the substituted memory', async () => {
    const mw = createChangeMiddleware([change.output('write', { draft: 'handwritten' })]);

    const result = await mw.middleware.beforeNodeExecute!(ctx(node('write'), stateWith()));

    expect(result?.shortCircuit?.payload).toEqual({ updates: { draft: 'handwritten' } });
  });

  it('leaves other nodes to execute', async () => {
    const mw = createChangeMiddleware([change.output('write', { draft: 'x' })]);

    expect(await mw.middleware.beforeNodeExecute!(ctx(node('other'), stateWith())))
      .toBeUndefined();
  });

  it('writes a tool substitution under the node result key', async () => {
    const mw = createChangeMiddleware([change.tool('fetch', 'payload')]);

    const result = await mw.middleware.beforeNodeExecute!(ctx(node('fetch', 'tool'), stateWith()));

    expect(result?.shortCircuit?.payload).toEqual({ updates: { fetch_result: 'payload' } });
  });

  it('uses the canonical idempotency key so the runner treats it as a real execution', async () => {
    const mw = createChangeMiddleware([change.output('write', { draft: 'x' })]);

    const result = await mw.middleware.beforeNodeExecute!(
      ctx(node('write'), stateWith({ iteration_count: 4 })),
    );

    expect(result?.shortCircuit?.idempotency_key).toBe('write:4:1');
  });

  it('records what it substituted, labelled by node type', async () => {
    const mw = createChangeMiddleware([change.output('write', { draft: 'x' }), change.tool('fetch', 1)]);

    await mw.middleware.beforeNodeExecute!(ctx(node('write'), stateWith()));
    await mw.middleware.beforeNodeExecute!(ctx(node('fetch', 'tool'), stateWith()));

    expect(mw.applied.map(a => a.kind)).toEqual(['output', 'tool']);
    expect(mw.applied[0].detail).toBe('substituted draft');
  });
});

describe('createChangeMiddleware — forced routing', () => {
  it('redirects the run leaving the named node', async () => {
    const mw = createChangeMiddleware([change.route('decide', 'high')]);

    expect(await mw.middleware.beforeAdvance!(ctx(node('decide', 'router'), stateWith()), 'low'))
      .toBe('high');
  });

  it('leaves other nodes routing normally', async () => {
    const mw = createChangeMiddleware([change.route('decide', 'high')]);

    expect(await mw.middleware.beforeAdvance!(ctx(node('other'), stateWith()), 'low'))
      .toBeUndefined();
  });

  it('applies a once-only route exactly once', async () => {
    const mw = createChangeMiddleware([change.route('decide', 'high', { once: true })]);
    const c = ctx(node('decide', 'router'), stateWith());

    expect(await mw.middleware.beforeAdvance!(c, 'low')).toBe('high');
    expect(await mw.middleware.beforeAdvance!(c, 'low')).toBeUndefined();
  });

  it('applies a repeating route every time', async () => {
    const mw = createChangeMiddleware([change.route('decide', 'high')]);
    const c = ctx(node('decide', 'router'), stateWith());

    expect(await mw.middleware.beforeAdvance!(c, 'low')).toBe('high');
    expect(await mw.middleware.beforeAdvance!(c, 'low')).toBe('high');
  });

  it('records the redirect it applied', async () => {
    const mw = createChangeMiddleware([change.route('decide', 'high')]);

    await mw.middleware.beforeAdvance!(ctx(node('decide', 'router'), stateWith()), 'low');

    expect(mw.applied[0]).toEqual({ nodeId: 'decide', kind: 'route', detail: 'low → high' });
  });
});

describe('canonicalJson', () => {
  it('sorts object keys so field order is not a difference', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });

  it('sorts nested keys too', () => {
    expect(canonicalJson({ x: { b: 1, a: 2 } })).toBe(canonicalJson({ x: { a: 2, b: 1 } }));
  });

  it('preserves array order, which is meaningful', () => {
    expect(canonicalEquals([1, 2], [2, 1])).toBe(false);
  });

  it('treats a key whose value is undefined as absent', () => {
    expect(canonicalEquals({ a: 1, b: undefined }, { a: 1 })).toBe(true);
  });

  it('serializes primitives and null', () => {
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson(7)).toBe('7');
    expect(canonicalJson('s')).toBe('"s"');
    expect(canonicalJson(undefined)).toBe('undefined');
  });

  it('distinguishes genuinely different values', () => {
    expect(canonicalEquals({ a: 1 }, { a: 2 })).toBe(false);
  });
});

describe('estimateTailCost', () => {
  const breakdown = (cost: number, calls = 1) => ({
    input_tokens: 0, output_tokens: 0, cost_usd: cost, calls,
  });

  it('sums the remaining nodes from the base run per-node costs', () => {
    const base = stateWith({
      visited_nodes: ['a', 'b', 'c'],
      node_breakdown: { a: breakdown(0.1), b: breakdown(0.2), c: breakdown(0.3) },
    });
    const prefix = stateWith({ visited_nodes: ['a', 'b'] });

    expect(estimateTailCost(base, prefix).costUsd).toBeCloseTo(0.5);
  });

  it('charges a repeated node its per-call average rather than its total', () => {
    const base = stateWith({
      visited_nodes: ['a', 'b'],
      node_breakdown: { b: breakdown(0.6, 3) },
    });
    const prefix = stateWith({ visited_nodes: ['a'] });

    expect(estimateTailCost(base, prefix).costUsd).toBeCloseTo(0.2);
  });

  it('ignores a node with no recorded calls', () => {
    const base = stateWith({
      visited_nodes: ['a', 'b'],
      node_breakdown: { b: breakdown(0.5, 0) },
    });
    const prefix = stateWith({ visited_nodes: ['a'] });

    expect(estimateTailCost(base, prefix).costUsd).toBe(0);
  });

  it('reports no headroom when the run has no budget', () => {
    const estimate = estimateTailCost(stateWith(), stateWith());

    expect(estimate.headroomUsd).toBeNull();
    expect(estimate.exceedsBudget).toBe(false);
  });

  it('reports headroom left at the fork point', () => {
    const base = stateWith({ visited_nodes: ['a'], node_breakdown: {} });
    const prefix = stateWith({ budget_usd: 1, total_cost_usd: 0.25 });

    expect(estimateTailCost(base, prefix).headroomUsd).toBeCloseTo(0.75);
  });

  it('flags a tail the remaining budget cannot cover', () => {
    const base = stateWith({
      visited_nodes: ['a', 'b'],
      node_breakdown: { b: breakdown(0.5) },
    });
    const prefix = stateWith({ visited_nodes: ['a'], budget_usd: 1, total_cost_usd: 0.9 });

    expect(estimateTailCost(base, prefix).exceedsBudget).toBe(true);
  });
});

describe('formatEstimate', () => {
  it('renders a single node and the absence of a cap', () => {
    const text = formatEstimate({ costUsd: 0.5, nodes: ['a'], headroomUsd: null, exceedsBudget: false });

    expect(text).toBe('~$0.5000 over 1 node, no budget cap');
  });

  it('renders several nodes and the remaining budget', () => {
    const text = formatEstimate({
      costUsd: 0.25, nodes: ['a', 'b'], headroomUsd: 2, exceedsBudget: false,
    });

    expect(text).toBe('~$0.2500 over 2 nodes, $2.0000 of budget left');
  });
});

describe('createForkGuard — policies', () => {
  const toolNode = node('fetch', 'tool');
  const noEvents: WorkflowEvent[] = [];

  it('lets a non-effectful node through untouched', async () => {
    const guard = createForkGuard({ events: noEvents, policy: 'replay', graph: graphOf(node('write')) });

    expect(await guard.middleware.beforeNodeExecute!(ctx(node('write'), stateWith())))
      .toBeUndefined();
  });

  it("blocks an effectful node outright under 'block'", async () => {
    const guard = createForkGuard({ events: noEvents, policy: 'block', graph: graphOf(toolNode) });

    await expect(guard.middleware.beforeNodeExecute!(ctx(toolNode, stateWith())))
      .rejects.toThrow(/policy.sideEffects is 'block'/);
  });

  it('blocks when no recording covers the node at this iteration', async () => {
    const guard = createForkGuard({ events: noEvents, policy: 'replay', graph: graphOf(toolNode) });

    await expect(guard.middleware.beforeNodeExecute!(ctx(toolNode, stateWith())))
      .rejects.toThrow(SideEffectBlockedError);
  });

  it('lets a named node through when explicitly allowed', async () => {
    const guard = createForkGuard({
      events: noEvents, policy: { allow: ['fetch'] }, graph: graphOf(toolNode),
    });

    expect(await guard.middleware.beforeNodeExecute!(ctx(toolNode, stateWith())))
      .toBeUndefined();
  });

  it('lets everything through when allow is true', async () => {
    const guard = createForkGuard({
      events: noEvents, policy: { allow: true }, graph: graphOf(toolNode),
    });

    expect(await guard.middleware.beforeNodeExecute!(ctx(toolNode, stateWith())))
      .toBeUndefined();
  });

  it('still blocks a node an allow list does not name', async () => {
    const guard = createForkGuard({
      events: noEvents, policy: { allow: ['other'] }, graph: graphOf(toolNode),
    });

    await expect(guard.middleware.beforeNodeExecute!(ctx(toolNode, stateWith())))
      .rejects.toThrow(SideEffectBlockedError);
  });
});

describe('createForkGuard — memory writer', () => {
  it('captures reflection writes instead of persisting them', async () => {
    const guard = createForkGuard({ events: [], policy: 'replay', graph: graphOf(node('r')) });
    let persisted = false;
    const wrapped = guard.wrapMemoryWriter(async () => {
      persisted = true;
      return { fact_ids: ['real'] };
    });

    const result = await wrapped([{ content: 'a' }, { content: 'b' }] as never);

    expect(persisted).toBe(false);
    expect(result.fact_ids).toHaveLength(2);
    expect(guard.suppressed[0]).toMatchObject({ kind: 'memory_write' });
  });

  it('labels the suppression with the writer idempotency key when given', async () => {
    const guard = createForkGuard({ events: [], policy: 'replay', graph: graphOf(node('r')) });
    const wrapped = guard.wrapMemoryWriter(async () => ({ fact_ids: [] }));

    await wrapped([{ content: 'a' }] as never, { idempotencyKey: 'run:reflect:1' });

    expect(guard.suppressed[0].nodeId).toBe('run:reflect:1');
  });
});

describe('createForkGuard — tool stubs', () => {
  it('stubs a custom tool the caller did not supply', () => {
    const graph = graphOf(node('fetch', 'tool', { tools: [{ type: 'custom', name: 'lookup' }] as never }));
    const guard = createForkGuard({ events: [], policy: 'replay', graph });

    const stubs = guard.toolStubs(new Set());

    expect(stubs.map(s => s.name)).toEqual(['lookup']);
  });

  it('leaves a tool the caller already supplied alone', () => {
    const graph = graphOf(node('fetch', 'tool', { tools: [{ type: 'custom', name: 'lookup' }] as never }));
    const guard = createForkGuard({ events: [], policy: 'replay', graph });

    expect(guard.toolStubs(new Set(['lookup']))).toEqual([]);
  });

  it('does not stub a tool for a node allowed to run for real', () => {
    const graph = graphOf(node('fetch', 'tool', { tools: [{ type: 'custom', name: 'lookup' }] as never }));
    const guard = createForkGuard({ events: [], policy: { allow: ['fetch'] }, graph });

    expect(guard.toolStubs(new Set())).toEqual([]);
  });

  it('throws if a stub is ever reached', async () => {
    const graph = graphOf(node('fetch', 'tool', { tools: [{ type: 'custom', name: 'lookup' }] as never }));
    const guard = createForkGuard({ events: [], policy: 'replay', graph });

    const [stub] = guard.toolStubs(new Set());
    await expect(stub!.execute({}, {} as never)).rejects.toThrow(SideEffectBlockedError);
  });
});
