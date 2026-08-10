/**
 * Run-path tests for capability isolation (docs/plans/capability-isolation.md):
 * a bundle child's tool and MCP surface is capped to its manifest's declared
 * requires. A tampered bundle whose manifest under-declares what its graph
 * uses fails closed — structurally at child startup for node sources, and at
 * the resolution choke point for agent-config sources. Nesting inherits the
 * cap. The tamper helper bypasses parseBundle deliberately: parse-time
 * integrity checking (tested in bundle.test.ts) rejects these artifacts at
 * load, and these tests prove the runtime ceiling holds as defense in depth
 * for a handcrafted object that never went through parseBundle.
 */

import { describe, it, expect, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import type { StateView } from '../src/types/state.js';

vi.mock('../src/agent/agent-executor/executor.js', () => ({
  executeAgent: vi.fn(async (
    agentId: string,
    _view: StateView,
    _tools: Record<string, unknown>,
    attempt: number,
    options?: { nodeId?: string; idempotencyKey?: string },
  ) => ({
    id: uuidv4(),
    idempotency_key: options?.idempotencyKey ?? uuidv4(),
    type: 'update_memory',
    payload: { updates: { out: `from:${options?.nodeId ?? agentId}` } },
    metadata: { node_id: options?.nodeId ?? agentId, agent_id: agentId, timestamp: new Date(), attempt },
  })),
}));

vi.mock('../src/utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { agent, node, subgraph, graph, run } from '../src/authoring/index.js';
import { bundle, parseBundle } from '../src/authoring/bundle.js';
import { tool } from '../src/tools/define-tool.js';
import { intersectCeilings } from '../src/tools/registry.js';
import type { Graph } from '../src/types/graph.js';
import type { GraphBundle } from '../src/types/bundle.js';

const noRetry = { maxRetries: 1, backoffStrategy: 'fixed', initialBackoffMs: 0, maxBackoffMs: 0 } as const;

const lookupOrder = tool({
  name: 'lookup_order',
  description: 'look up an order',
  parameters: z.object({ id: z.string() }),
  execute: async () => 'ok',
});

function graphWithAgentTool(): Graph {
  const worker = node({
    id: 'worker',
    agent: agent({ model: 'claude-sonnet-4-6', instructions: 'x', tools: [lookupOrder] }),
    reads: ['goal_in'],
    writes: 'out',
    failurePolicy: noRetry,
  });
  return graph({ name: 'agent-tool-block', nodes: [worker], edges: [] });
}

function graphWithNodeTool(): Graph {
  const worker = node({
    id: 'worker',
    agent: agent({ model: 'claude-sonnet-4-6', instructions: 'x' }),
    tools: [lookupOrder],
    reads: ['goal_in'],
    writes: 'out',
    failurePolicy: noRetry,
  });
  return graph({ name: 'node-tool-block', nodes: [worker], edges: [] });
}

function tamper(b: GraphBundle): GraphBundle {
  const wire = JSON.parse(JSON.stringify(b)) as { manifest: { requires: { tools: unknown[] } } };
  wire.manifest.requires.tools = [];
  return wire as unknown as GraphBundle;
}

function consumer(child: GraphBundle): Graph {
  return graph({
    name: 'consumer',
    nodes: [
      subgraph(child, {
        id: 'call',
        writes: 'result',
        outputs: { out: 'result' },
        failurePolicy: noRetry,
      }),
    ],
  });
}

describe('capability isolation', () => {
  it('runs an honest bundle whose usage matches its manifest', async () => {
    const parsed = parseBundle(JSON.parse(JSON.stringify(bundle(graphWithAgentTool(), { version: '1.0.0' }))));

    const memory = await run(consumer(parsed), { goal: 'go' }, {
      runner: { tools: [lookupOrder] },
    });

    expect(memory.result).toBe('from:worker');
  });

  it('fails a tampered bundle at child startup when a node source exceeds the ceiling', async () => {
    const tampered = tamper(bundle(graphWithNodeTool(), { version: '1.0.0' }));

    await expect(
      run(consumer(tampered), { goal: 'go' }, { runner: { tools: [lookupOrder] } }),
    ).rejects.toThrow(/outside the graph's declared capability ceiling/);
  });

  it('fails a tampered bundle at resolution when an agent-config source exceeds the ceiling', async () => {
    const tampered = tamper(bundle(graphWithAgentTool(), { version: '1.0.0' }));

    await expect(
      run(consumer(tampered), { goal: 'go' }, { runner: { tools: [lookupOrder] } }),
    ).rejects.toThrow(/outside this graph's declared capability ceiling/);
  });

  it('caps a nested grandchild by the enclosing bundle manifest', async () => {
    const grandchild = graphWithNodeTool();
    const middle = graph({
      name: 'middle',
      nodes: [
        subgraph(grandchild, {
          id: 'call-leaf',
          writes: 'out',
          outputs: { out: 'out' },
          failurePolicy: noRetry,
        }),
      ],
    });
    const tampered = tamper(bundle(middle, { version: '1.0.0' }));

    await expect(
      run(consumer(tampered), { goal: 'go' }, { runner: { tools: [lookupOrder] } }),
    ).rejects.toThrow(/capability ceiling/);
  });
});

describe('ComposedToolResolution — ceiling enforcement', () => {
  it('refuses an mcp source outside the ceiling at resolution', async () => {
    const { ComposedToolResolution, CapabilityViolationError } = await import('../src/tools/registry.js');
    const resolution = new ComposedToolResolution([lookupOrder], {
      capabilityCeiling: { tools: ['lookup_order'], mcpServers: ['allowed-server'] },
    });

    await expect(
      resolution.resolveTools([{ type: 'mcp', server_id: 'forbidden-server' }]),
    ).rejects.toThrow(CapabilityViolationError);
  });

  it('refuses a registered tool that the ceiling does not declare', async () => {
    const { ComposedToolResolution } = await import('../src/tools/registry.js');
    const resolution = new ComposedToolResolution([lookupOrder], {
      capabilityCeiling: { tools: [], mcpServers: [] },
    });

    await expect(
      resolution.resolveTools([{ type: 'custom', name: 'lookup_order' }]),
    ).rejects.toThrow(/outside this graph's declared capability ceiling/);
  });
});

describe('collectClosure — cross-graph conflicts', () => {
  it('rejects two distinct agent definitions pinned to one id across graphs', async () => {
    const childWorker = node({
      id: 'child-worker',
      agent: agent({ id: 'dup-agent', model: 'claude-sonnet-4-6', instructions: 'child version' }),
      writes: 'out',
    });
    const child = graph({ name: 'child', nodes: [childWorker], edges: [] });
    const parentWorker = node({
      id: 'parent-worker',
      agent: agent({ id: 'dup-agent', model: 'claude-sonnet-4-6', instructions: 'parent version' }),
      writes: 'result',
    });
    const parent = graph({
      name: 'parent',
      nodes: [
        subgraph(child, { id: 'call', writes: 'raw', outputs: { out: 'raw' }, failurePolicy: noRetry }),
        parentWorker,
      ],
      edges: [{ from: 'call', to: 'parent-worker' }],
    });

    await expect(run(parent, { goal: 'conflict' })).rejects.toThrow(
      /defined differently in two graphs/,
    );
  });

  it('rejects two distinct child graphs sharing an id across nesting levels', async () => {
    const childA = graphWithNodeTool();
    const impostor = { ...graphWithNodeTool(), id: childA.id };
    const middle = graph({
      name: 'middle',
      nodes: [subgraph(impostor, { id: 'call-impostor', writes: 'out', failurePolicy: noRetry })],
    });
    const parent = graph({
      name: 'parent',
      nodes: [
        subgraph(childA, { id: 'call-a', writes: 'a', failurePolicy: noRetry }),
        subgraph(middle, { id: 'call-middle', writes: 'b', failurePolicy: noRetry }),
      ],
      edges: [{ from: 'call-a', to: 'call-middle' }],
    });

    await expect(run(parent, { goal: 'dup' })).rejects.toThrow(
      /Two distinct child graphs share the id/,
    );
  });
});

describe('intersectCeilings', () => {
  it('keeps only the surface allowed by both ceilings', () => {
    const result = intersectCeilings(
      { tools: ['a', 'b'], mcpServers: ['s1', 's2'] },
      { tools: ['b', 'c'], mcpServers: ['s2', 's3'] },
    );

    expect(result).toEqual({ tools: ['b'], mcpServers: ['s2'] });
  });
});
