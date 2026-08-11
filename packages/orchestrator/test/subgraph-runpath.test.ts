/**
 * Run-path tests for subgraph() auto-wiring: a facade run() composing child
 * graphs must resolve them through a REAL GraphRunner with no hand-wired
 * loadGraph, register child agents transitively into the run scope, and let
 * a caller-supplied loadGraph win for ids it resolves. Guards the pipeline:
 * subgraph() brand → graph() collection → run() closure → child runner.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import type { StateView } from '../src/state/state.js';
import type { AgentFactory } from '../src/agents/factory/index.js';

const capturedFactories: AgentFactory[] = [];

vi.mock('../src/agents/executors/agent/executor.js', () => ({
  executeAgent: vi.fn(async (
    agentId: string,
    _view: StateView,
    _tools: Record<string, unknown>,
    attempt: number,
    options?: { agentFactory?: AgentFactory; nodeId?: string; idempotencyKey?: string },
  ) => {
    if (options?.agentFactory) capturedFactories.push(options.agentFactory);
    return {
      id: uuidv4(),
      idempotency_key: options?.idempotencyKey ?? uuidv4(),
      type: 'update_memory',
      payload: { updates: { out: `from:${options?.nodeId ?? agentId}` } },
      metadata: { node_id: options?.nodeId ?? agentId, agent_id: agentId, timestamp: new Date(), attempt },
    };
  }),
}));

vi.mock('../src/observability/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { z } from 'zod';
import { agent, node, subgraph, graph, run, state, agentsForGraph, graphsForGraph } from '../src/authoring/index.js';
import type { AgentValue } from '../src/authoring/agent.js';
import type { Graph } from '../src/graph/graph.js';
import { GraphRunner } from '../src/execution/engine/graph-runner.js';
import { InMemoryAgentRegistry } from '../src/persistence/in-memory.js';

const CHILD_INSTRUCTIONS = 'child researcher instructions';

function childGraph(name: string, workerId: string, worker?: AgentValue): Graph {
  const placed = node({
    id: workerId,
    agent: worker ?? agent({ model: 'claude-sonnet-4-6', instructions: CHILD_INSTRUCTIONS }),
    reads: ['goal_in'],
    writes: 'out',
  });
  return graph({ name, nodes: [placed], edges: [] });
}

beforeEach(() => {
  capturedFactories.length = 0;
});

describe('run — subgraph auto-wiring', () => {
  it('resolves an in-scope child and maps its output back without a hand-wired loadGraph', async () => {
    const child = childGraph('child', 'child-worker');
    const parent = graph({
      name: 'parent',
      nodes: [
        subgraph(child, {
          id: 'call-child',
          reads: ['topic'],
          writes: 'result',
          inputs: { topic: 'goal_in' },
          outputs: { out: 'result' },
        }),
      ],
    });

    const memory = await run(parent, { goal: 'compose', memory: { topic: 'volcanoes' } });

    expect(memory.result).toBe('from:child-worker');
  });

  it('registers child agents into the run scope transitively', async () => {
    const child = childGraph('child', 'child-worker');
    const childAgentId = child.nodes[0].agent_id!;
    const parent = graph({
      name: 'parent',
      nodes: [subgraph(child, { id: 'call-child', writes: 'result', outputs: { out: 'result' } })],
    });

    await run(parent, { goal: 'compose' });

    expect(capturedFactories.length).toBeGreaterThan(0);
    const loaded = await capturedFactories[0].loadAgent(childAgentId);
    expect(loaded.system).toBe(CHILD_INSTRUCTIONS);
  });

  it('resolves a grandchild through the same closure', async () => {
    const grandchild = childGraph('grandchild', 'leaf-worker');
    const middle = graph({
      name: 'middle',
      nodes: [
        subgraph(grandchild, {
          id: 'call-leaf',
          writes: 'out',
          outputs: { out: 'out' },
        }),
      ],
    });
    const parent = graph({
      name: 'parent',
      nodes: [subgraph(middle, { id: 'call-middle', writes: 'result', outputs: { out: 'result' } })],
    });

    const memory = await run(parent, { goal: 'nest' });

    expect(memory.result).toBe('from:leaf-worker');
  });

  it('resolves a string-id child through a caller-supplied loadGraph', async () => {
    const external = childGraph('external', 'external-worker');
    const parent = graph({
      name: 'parent',
      nodes: [
        subgraph('acme/research', { id: 'call-external', writes: 'result', outputs: { out: 'result' } }),
      ],
    });

    const memory = await run(parent, { goal: 'compose' }, {
      runner: {
        loadGraph: async (id) => (id === 'acme/research' ? external : null),
      },
    });

    expect(memory.result).toBe('from:external-worker');
  });

  it('prefers a caller loadGraph over the stash for the same id', async () => {
    const sharedAgent = agent({ model: 'claude-sonnet-4-6', instructions: CHILD_INSTRUCTIONS });
    const stashed = childGraph('stashed', 'stash-worker', sharedAgent);
    const replacement = childGraph('replacement', 'caller-worker', sharedAgent);
    const parent = graph({
      name: 'parent',
      nodes: [subgraph(stashed, { id: 'call-child', writes: 'result', outputs: { out: 'result' } })],
    });

    const memory = await run(parent, { goal: 'override' }, {
      runner: {
        loadGraph: async (id) => (id === stashed.id ? replacement : null),
      },
    });

    expect(memory.result).toBe('from:caller-worker');
  });

  it('falls back to the stash when the caller loadGraph returns null', async () => {
    const child = childGraph('child', 'child-worker');
    const parent = graph({
      name: 'parent',
      nodes: [subgraph(child, { id: 'call-child', writes: 'result', outputs: { out: 'result' } })],
    });

    const memory = await run(parent, { goal: 'fallback' }, {
      runner: { loadGraph: async () => null },
    });

    expect(memory.result).toBe('from:child-worker');
  });
});

const noRetry = { maxRetries: 1, backoffStrategy: 'fixed', initialBackoffMs: 0, maxBackoffMs: 0 } as const;

function interfaceChild(io: { inputs?: Record<string, z.ZodType>; outputs?: Record<string, z.ZodType> }): Graph {
  const worker = node({
    id: 'iface-worker',
    agent: agent({ model: 'claude-sonnet-4-6', instructions: CHILD_INSTRUCTIONS }),
    reads: ['goal_in'],
    writes: 'out',
  });
  return graph({ name: 'iface-child', nodes: [worker], edges: [], ...io });
}

async function runToFinalState(parent: Graph, seedMemory: Record<string, unknown>, loadGraph?: (id: string) => Promise<Graph | null>) {
  const registry = new InMemoryAgentRegistry();
  for (const config of agentsForGraph(parent)) registry.register(config);
  for (const child of graphsForGraph(parent)) {
    for (const config of agentsForGraph(child)) registry.register(config);
  }
  const stash = new Map(graphsForGraph(parent).map((child) => [child.id, child]));
  const resolve = loadGraph ?? (async (id: string) => stash.get(id) ?? null);
  const runner = new GraphRunner(parent, state({ workflowId: parent.id, goal: 'boundary', memory: seedMemory }), {
    registry,
    loadGraph: resolve,
  });
  return runner.run();
}

describe('run — subgraph boundary validation', () => {
  it('passes values that satisfy the declared interface', async () => {
    const child = interfaceChild({ inputs: { goal_in: z.string() }, outputs: { out: z.string() } });
    const parent = graph({
      name: 'parent',
      nodes: [
        subgraph(child, {
          id: 'call', reads: ['topic'], writes: 'result',
          inputs: { topic: 'goal_in' }, outputs: { out: 'result' },
          failurePolicy: noRetry,
        }),
      ],
    });

    const finalState = await runToFinalState(parent, { topic: 'volcanoes' });

    expect(finalState.status).toBe('completed');
    expect(finalState.memory.result).toBe('from:iface-worker');
  });

  it('rejects the run when a mapped input violates its schema', async () => {
    const child = interfaceChild({ inputs: { goal_in: z.number() } });
    const parent = graph({
      name: 'parent',
      nodes: [
        subgraph(child, {
          id: 'call', reads: ['topic'], writes: 'result',
          inputs: { topic: 'goal_in' }, outputs: { out: 'result' },
          failurePolicy: noRetry,
        }),
      ],
    });

    await expect(runToFinalState(parent, { topic: 'volcanoes' })).rejects.toThrow(
      /input "goal_in" violates the declared interface/,
    );
  });

  it('rejects the run when a mapped output violates its schema', async () => {
    const child = interfaceChild({ inputs: { goal_in: z.string() }, outputs: { out: z.number() } });
    const parent = graph({
      name: 'parent',
      nodes: [
        subgraph(child, {
          id: 'call', reads: ['topic'], writes: 'result',
          inputs: { topic: 'goal_in' }, outputs: { out: 'result' },
          failurePolicy: noRetry,
        }),
      ],
    });

    await expect(runToFinalState(parent, { topic: 'volcanoes' })).rejects.toThrow(
      /output "out" violates the declared interface/,
    );
  });

  it('rejects at runtime when a required input is missing on the id-resolved path', async () => {
    const child = interfaceChild({ inputs: { goal_in: z.string() } });
    const parent = graph({
      name: 'parent',
      nodes: [
        subgraph('external-iface', { id: 'call', writes: 'result', outputs: { out: 'result' }, failurePolicy: noRetry }),
      ],
    });

    await expect(
      runToFinalState(parent, {}, async (id) => (id === 'external-iface' ? child : null)),
    ).rejects.toThrow(/required input was not provided/);
  });
});
