/**
 * Tests for fingerprint memoization (src/replay/fingerprint.ts, memoize.ts):
 * serving a forked tail its recorded output when the change could not have
 * reached that node.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';

const calls = vi.hoisted(() => ({ byNode: [] as string[] }));

vi.mock('../src/agents/executors/agent/executor', () => ({
  executeAgent: vi.fn(async (agentId: string, _view: unknown, _tools: unknown, attempt: number, opts: { nodeId?: string }) => {
    const nodeId = opts?.nodeId ?? agentId;
    calls.byNode.push(nodeId);
    return {
      id: uuidv4(),
      idempotency_key: `${nodeId}:${attempt}`,
      type: 'update_memory',
      payload: { updates: { [`${nodeId}_out`]: `${nodeId}#${calls.byNode.length}` } },
      metadata: { node_id: nodeId, agent_id: agentId, timestamp: new Date(), attempt },
    };
  }),
}));

vi.mock('@opentelemetry/api', () => ({
  trace: {
    getActiveSpan: () => undefined,
    getTracer: () => ({
      startActiveSpan: (_n: string, _o: unknown, fn: (s: unknown) => unknown) =>
        fn({ setAttribute: vi.fn(), setStatus: vi.fn(), recordException: vi.fn(), end: vi.fn() }),
    }),
  },
  isSpanContextValid: () => false,
  SpanStatusCode: { OK: 0, ERROR: 2 },
  context: {},
}));

import { fork } from '../src/replay/fork.js';
import { change } from '../src/replay/mutations.js';
import { computeFingerprint } from '../src/replay/fingerprint.js';
import { createGraph } from '../src/graph/graph.js';
import { createWorkflowState } from '../src/state/state.js';
import { GraphRunner } from '../src/execution/engine/graph-runner.js';
import { InMemoryEventLogWriter } from '../src/persistence/event-log.js';
import { InMemoryAgentRegistry } from '../src/persistence/in-memory.js';
import type { Graph } from '../src/graph/graph.js';

interface Recorded {
  graph: Graph;
  runId: string;
  eventLog: InMemoryEventLogWriter;
  registry: InMemoryAgentRegistry;
}

/**
 * A diamond: seed fans out to `left` and `right`, which join at `merge`.
 * `right` reads only `seed_out`, so a change to `left` cannot reach it.
 */
async function recordDiamond(): Promise<Recorded> {
  const registry = new InMemoryAgentRegistry();
  const mk = (name: string) => registry.register({
    name, model: 'claude-sonnet-4-6', provider: 'anthropic', systemPrompt: name,
  });

  const graph = createGraph({
    name: 'diamond',
    description: 'seed fans out to two independent branches',
    nodes: [
      { id: 'seed', type: 'agent', agentId: mk('Seed'), readKeys: ['goal'], writeKeys: ['seed_out'] },
      { id: 'left', type: 'agent', agentId: mk('Left'), readKeys: ['seed_out'], writeKeys: ['left_out'] },
      { id: 'right', type: 'agent', agentId: mk('Right'), readKeys: ['seed_out'], writeKeys: ['right_out'] },
      { id: 'merge', type: 'agent', agentId: mk('Merge'), readKeys: ['left_out', 'right_out'], writeKeys: ['merge_out'] },
    ],
    edges: [
      { source: 'seed', target: 'left' },
      { source: 'left', target: 'right' },
      { source: 'right', target: 'merge' },
    ],
    startNode: 'seed',
    endNodes: ['merge'],
  });

  const eventLog = new InMemoryEventLogWriter();
  const initial = createWorkflowState({ workflowId: graph.id, goal: 'diamond' });
  await new GraphRunner(graph, initial, { registry, eventLog, compactionInterval: 0 }).run();

  return { graph, runId: initial.run_id, eventLog, registry };
}

beforeEach(() => {
  calls.byNode = [];
});

describe('computeFingerprint', () => {
  it('matches for the same node, agent and read slice', async () => {
    const base = await recordDiamond();
    const state = createWorkflowState({ workflowId: base.graph.id, goal: 'g', memory: { seed_out: 's' } });
    const node = base.graph.nodes[1];

    const a = await computeFingerprint({ node, graph: base.graph, state, registry: base.registry });
    const b = await computeFingerprint({ node, graph: base.graph, state, registry: base.registry });

    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });

  it('differs when the readable memory differs', async () => {
    const base = await recordDiamond();
    const node = base.graph.nodes[1];
    const mk = (seed: string) => createWorkflowState({
      workflowId: base.graph.id, goal: 'g', memory: { seed_out: seed },
    });

    const a = await computeFingerprint({ node, graph: base.graph, state: mk('one'), registry: base.registry });
    const b = await computeFingerprint({ node, graph: base.graph, state: mk('two'), registry: base.registry });

    expect(a).not.toBe(b);
  });

  it('ignores memory the node cannot read', async () => {
    const base = await recordDiamond();
    const node = base.graph.nodes[1];
    const mk = (extra: Record<string, unknown>) => createWorkflowState({
      workflowId: base.graph.id, goal: 'g', memory: { seed_out: 's', ...extra },
    });

    const a = await computeFingerprint({ node, graph: base.graph, state: mk({}), registry: base.registry });
    const b = await computeFingerprint({ node, graph: base.graph, state: mk({ unrelated: 'x' }), registry: base.registry });

    expect(a).toBe(b);
  });

  it('differs when the agent model differs', async () => {
    const base = await recordDiamond();
    const node = base.graph.nodes[1];
    const state = createWorkflowState({ workflowId: base.graph.id, goal: 'g', memory: { seed_out: 's' } });

    const before = await computeFingerprint({ node, graph: base.graph, state, registry: base.registry });
    await base.registry.updateAgent(node.agent_id!, { model: 'claude-opus-5' });
    const after = await computeFingerprint({ node, graph: base.graph, state, registry: base.registry });

    expect(before).not.toBe(after);
  });

  it('differs when the goal differs', async () => {
    const base = await recordDiamond();
    const node = base.graph.nodes[1];
    const mk = (goal: string) => createWorkflowState({
      workflowId: base.graph.id, goal, memory: { seed_out: 's' },
    });

    const a = await computeFingerprint({ node, graph: base.graph, state: mk('one'), registry: base.registry });
    const b = await computeFingerprint({ node, graph: base.graph, state: mk('two'), registry: base.registry });

    expect(a).not.toBe(b);
  });

  it('hashes a node that drives no agent at all', async () => {
    const base = await recordDiamond();
    const node = { ...base.graph.nodes[1], agent_id: undefined };
    const state = createWorkflowState({ workflowId: base.graph.id, goal: 'g' });

    expect(await computeFingerprint({ node, graph: base.graph, state, registry: base.registry }))
      .toMatch(/^[a-f0-9]{64}$/);
  });

  it('hashes every readable key for a wildcard read slice', async () => {
    const base = await recordDiamond();
    const node = { ...base.graph.nodes[1], read_keys: ['*'] };
    const mk = (extra: Record<string, unknown>) => createWorkflowState({
      workflowId: base.graph.id, goal: 'g', memory: { seed_out: 's', ...extra },
    });

    const a = await computeFingerprint({ node, graph: base.graph, state: mk({}), registry: base.registry });
    const b = await computeFingerprint({ node, graph: base.graph, state: mk({ other: 1 }), registry: base.registry });

    expect(a).not.toBe(b);
  });

  it('ignores engine-reserved keys under a wildcard read slice', async () => {
    const base = await recordDiamond();
    const node = { ...base.graph.nodes[1], read_keys: ['*'] };
    const mk = (extra: Record<string, unknown>) => createWorkflowState({
      workflowId: base.graph.id, goal: 'g', memory: { seed_out: 's', ...extra },
    });

    const a = await computeFingerprint({ node, graph: base.graph, state: mk({}), registry: base.registry });
    const b = await computeFingerprint({ node, graph: base.graph, state: mk({ _internal: 1 }), registry: base.registry });

    expect(a).toBe(b);
  });

  it('hashes a rule-based reflection node without an extractor agent', async () => {
    const base = await recordDiamond();
    const node = {
      ...base.graph.nodes[1],
      agent_id: undefined,
      type: 'reflection' as const,
      reflection_config: { source_keys: ['seed_out'], extractor: { type: 'rule_based' } },
    };
    const state = createWorkflowState({ workflowId: base.graph.id, goal: 'g' });

    expect(await computeFingerprint({ node: node as never, graph: base.graph, state, registry: base.registry }))
      .toMatch(/^[a-f0-9]{64}$/);
  });

  it('returns null when an agent the node references is not in the registry', async () => {
    const base = await recordDiamond();
    const node = { ...base.graph.nodes[1], agent_id: 'missing-agent' };
    const state = createWorkflowState({ workflowId: base.graph.id, goal: 'g' });

    expect(await computeFingerprint({ node, graph: base.graph, state, registry: base.registry }))
      .toBeNull();
  });

  it('hashes the agents a verifier node judges through', async () => {
    const base = await recordDiamond();
    const judge = base.graph.nodes[2].agent_id!;
    const node = {
      ...base.graph.nodes[1],
      agent_id: undefined,
      type: 'verifier' as const,
      verifier_config: { type: 'llm_judge' as const, evaluator_agent_id: judge, criteria: 'good', threshold: 0.5, max_attempts: 1, on_failure: 'fail' as const },
    };
    const state = createWorkflowState({ workflowId: base.graph.id, goal: 'g', memory: { seed_out: 's' } });

    const before = await computeFingerprint({ node, graph: base.graph, state, registry: base.registry });
    await base.registry.updateAgent(judge, { model: 'claude-opus-5' });
    const after = await computeFingerprint({ node, graph: base.graph, state, registry: base.registry });

    expect(before).not.toBe(after);
  });
});

describe('fork — memoization', () => {
  it('re-runs every tail node when memoization is off', async () => {
    const base = await recordDiamond();
    calls.byNode = [];

    await fork(base.runId, {
      at: { beforeNode: 'left' },
      change: change.prompt('left', 'different instructions'),
      eventLog: base.eventLog,
      graph: base.graph,
      registry: base.registry,
    });

    expect(calls.byNode).toEqual(['left', 'right', 'merge']);
  });

  it('serves the branch the change could not reach', async () => {
    const base = await recordDiamond();
    calls.byNode = [];

    const f = await fork(base.runId, {
      at: { beforeNode: 'left' },
      change: change.prompt('left', 'different instructions'),
      eventLog: base.eventLog,
      graph: base.graph,
      registry: base.registry,
      policy: { memoize: true },
    });

    expect(calls.byNode).toEqual(['left', 'merge']);
    expect(f.memoHits.map(h => h.nodeId)).toEqual(['right']);
  });

  it('still runs the node downstream of the change', async () => {
    const base = await recordDiamond();

    const f = await fork(base.runId, {
      at: { beforeNode: 'left' },
      change: change.prompt('left', 'different instructions'),
      eventLog: base.eventLog,
      graph: base.graph,
      registry: base.registry,
      policy: { memoize: true },
    });

    expect(f.memoHits.map(h => h.nodeId)).not.toContain('merge');
  });

  it('reproduces the base run exactly when nothing changed', async () => {
    const base = await recordDiamond();
    calls.byNode = [];

    const f = await fork(base.runId, {
      at: { beforeNode: 'left' },
      eventLog: base.eventLog,
      graph: base.graph,
      registry: base.registry,
      policy: { memoize: true },
    });

    expect(calls.byNode).toEqual([]);
    expect(f.memoHits.map(h => h.nodeId)).toEqual(['left', 'right', 'merge']);
  });

  it('leaves the memo hit list empty when memoization is off', async () => {
    const base = await recordDiamond();

    const f = await fork(base.runId, {
      at: { beforeNode: 'left' },
      eventLog: base.eventLog,
      graph: base.graph,
      registry: base.registry,
    });

    expect(f.memoHits).toEqual([]);
  });
});
