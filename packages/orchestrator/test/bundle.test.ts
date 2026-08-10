/**
 * Tests for graph bundles (src/authoring/bundle.ts + src/types/bundle.ts):
 * manifest assembly, wire-form agent embedding, the transitive graph
 * closure, JSON round-tripping through parseBundle, and the run path —
 * a serialized bundle dropped into a new composition via subgraph()
 * executes with its agents auto-registered.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import type { StateView } from '../src/types/state.js';
import type { AgentFactory } from '../src/agent/agent-factory/index.js';

const capturedFactories: AgentFactory[] = [];

vi.mock('../src/agent/agent-executor/executor.js', () => ({
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

vi.mock('../src/utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { agent, node, subgraph, graph, run } from '../src/authoring/index.js';
import { bundle, parseBundle, BundleIntegrityError } from '../src/authoring/bundle.js';
import { GraphSpecError } from '../src/authoring/errors.js';
import { tool } from '../src/tools/define-tool.js';
import type { Graph } from '../src/types/graph.js';
import type { GraphBundle } from '../src/types/bundle.js';

const WORKER_INSTRUCTIONS = 'bundled research specialist';

const lookupOrder = tool({
  name: 'lookup_order',
  description: 'look up an order',
  parameters: z.object({ id: z.string() }),
  execute: async () => 'ok',
});

function graphWithAgentTools(): Graph {
  const worker = node({
    id: 'worker',
    agent: agent({ model: 'claude-sonnet-4-6', instructions: 'x', tools: [lookupOrder] }),
    writes: 'out',
  });
  return graph({ name: 'agent-tools-block', nodes: [worker], edges: [] });
}

function researchGraph(): Graph {
  const worker = node({
    id: 'worker',
    agent: agent({ model: 'claude-sonnet-4-6', instructions: WORKER_INSTRUCTIONS }),
    reads: ['goal_in'],
    writes: 'out',
  });
  return graph({
    name: 'research-block',
    description: 'a reusable research block',
    nodes: [worker],
    edges: [],
    inputs: { goal_in: z.string() },
    outputs: { out: z.string() },
  });
}

function roundTrip(b: GraphBundle): GraphBundle {
  return parseBundle(JSON.parse(JSON.stringify(b)));
}

beforeEach(() => {
  capturedFactories.length = 0;
});

describe('bundle', () => {
  it('lifts the graph interface and identity into the manifest', () => {
    const g = researchGraph();

    const b = bundle(g, { version: '1.2.0' });

    expect(b.manifest.name).toBe('research-block');
    expect(b.manifest.version).toBe('1.2.0');
    expect(b.manifest.description).toBe('a reusable research block');
    expect(b.manifest.inputs.goal_in.schema).toMatchObject({ type: 'string' });
    expect(b.manifest.outputs.out.schema).toMatchObject({ type: 'string' });
    expect(b.graph).toBe(g);
  });

  it('computes requires with tool schemas, servers, and models', () => {
    const fetchPage = tool({
      name: 'fetch_page',
      description: 'fetch',
      parameters: z.object({ url: z.string() }),
      execute: async () => 'html',
      taints: true,
    });
    const worker = node({
      id: 'worker',
      agent: agent({ model: 'claude-sonnet-4-6', instructions: 'x', tools: [fetchPage, { mcp: 'web-search' }] }),
      writes: 'out',
    });
    const g = graph({ name: 'g', nodes: [worker], edges: [] });

    const b = bundle(g, { version: '0.1.0' });

    expect(b.manifest.requires).toEqual({
      tools: [{ name: 'fetch_page', input_schema: expect.objectContaining({ type: 'object' }), taints: true }],
      mcp_servers: [{ id: 'web-search' }],
      models: ['claude-sonnet-4-6'],
    });
  });

  it('embeds agent definitions in snake_case wire form with structured tools', () => {
    const g = researchGraph();

    const b = bundle(g, { version: '0.1.0' });

    expect(b.agents).toHaveLength(1);
    expect(b.agents[0].system_prompt).toBe(WORKER_INSTRUCTIONS);
    expect(b.agents[0].model).toBe('claude-sonnet-4-6');
    expect(b.agents[0].id).toBe(g.nodes[0].agent_id);
  });

  it('embeds the transitive child-graph closure', () => {
    const grandchild = researchGraph();
    const middle = graph({
      name: 'middle',
      nodes: [
        subgraph(grandchild, {
          id: 'call-leaf',
          writes: 'out',
          inputs: { goal_in: 'goal_in' },
          outputs: { out: 'out' },
        }),
      ],
      inputs: { goal_in: z.string() },
      outputs: { out: z.string() },
    });

    const b = bundle(middle, { version: '0.1.0' });

    expect(b.graphs.map((child) => child.id)).toEqual([grandchild.id]);
    expect(b.agents).toHaveLength(1);
  });

  it('round-trips through JSON and parseBundle', () => {
    const b = bundle(researchGraph(), { version: '1.0.0' });

    const parsed = roundTrip(b);

    expect(parsed.manifest).toEqual(b.manifest);
    expect(parsed.graph.id).toBe(b.graph.id);
    expect(parsed.agents).toEqual(b.agents);
  });

  it('records and round-trips the provenance source', () => {
    const b = bundle(researchGraph(), { version: '1.0.0', source: 'npm:@acme/research-graph' });

    expect(b.manifest.source).toBe('npm:@acme/research-graph');
    expect(roundTrip(b).manifest.source).toBe('npm:@acme/research-graph');
  });

  it('leaves provenance absent when no source is given', () => {
    const b = bundle(researchGraph(), { version: '1.0.0' });

    expect(b.manifest.source).toBeUndefined();
    expect(JSON.stringify(b.manifest)).not.toContain('"source"');
  });

  it('omits the manifest description when the graph has none and meta gives none', () => {
    const worker = node({
      id: 'worker',
      agent: agent({ model: 'claude-sonnet-4-6', instructions: 'x' }),
      writes: 'out',
    });
    const g = graph({ name: 'undescribed', nodes: [worker], edges: [] });

    const b = bundle(g, { version: '0.0.1' });

    expect(b.manifest.description).toBeUndefined();
  });

  it('rejects a malformed bundle', () => {
    expect(() => parseBundle({})).toThrow();
    expect(() => parseBundle({ manifest: { name: 'x' } })).toThrow();
  });

  it('rejects a bundle whose agent tools exceed the manifest requires', () => {
    const wire = JSON.parse(JSON.stringify(bundle(graphWithAgentTools(), { version: '1.0.0' })));
    wire.manifest.requires.tools = [];

    expect(() => parseBundle(wire)).toThrow(BundleIntegrityError);
    expect(() => parseBundle(wire)).toThrow(/uses custom tool "lookup_order" not declared/);
  });

  it('rejects a bundle whose node sources exceed the manifest requires', () => {
    const worker = node({
      id: 'worker',
      agent: agent({ model: 'claude-sonnet-4-6', instructions: 'x' }),
      tools: [{ mcp: 'web-search' }],
      writes: 'out',
    });
    const g = graph({ name: 'node-mcp', nodes: [worker], edges: [] });
    const wire = JSON.parse(JSON.stringify(bundle(g, { version: '1.0.0' })));
    wire.manifest.requires.mcp_servers = [];

    expect(() => parseBundle(wire)).toThrow(/uses MCP server "web-search" not declared/);
  });

  it('rejects a bundle whose agent model exceeds the manifest requires', () => {
    const wire = JSON.parse(JSON.stringify(bundle(researchGraph(), { version: '1.0.0' })));
    wire.manifest.requires.models = [];

    expect(() => parseBundle(wire)).toThrow(/uses model "claude-sonnet-4-6" not declared/);
  });

  it('lists every violation in one integrity error', () => {
    const wire = JSON.parse(JSON.stringify(bundle(graphWithAgentTools(), { version: '1.0.0' })));
    wire.manifest.requires = { tools: [], mcp_servers: [], models: [] };

    try {
      parseBundle(wire);
      expect.unreachable('parseBundle should have thrown');
    } catch (error) {
      const integrity = error as BundleIntegrityError;
      expect(integrity.violations).toHaveLength(2);
    }
  });
});

describe('run — bundle consumption', () => {
  it('executes a deserialized bundle with its agents auto-registered', async () => {
    const parsed = roundTrip(bundle(researchGraph(), { version: '1.0.0' }));
    const parent = graph({
      name: 'consumer',
      nodes: [
        subgraph(parsed, {
          id: 'research',
          reads: ['topic'],
          writes: 'result',
          inputs: { topic: 'goal_in' },
          outputs: { out: 'result' },
        }),
      ],
    });

    const memory = await run(parent, { goal: 'consume', memory: { topic: 'volcanoes' } });

    expect(memory.result).toBe('from:worker');
    expect(capturedFactories.length).toBeGreaterThan(0);
    const loaded = await capturedFactories[0].loadAgent(parsed.agents[0].id);
    expect(loaded.system).toBe(WORKER_INSTRUCTIONS);
  });

  it('validates mappings against a deserialized bundle interface at compile time', () => {
    const parsed = roundTrip(bundle(researchGraph(), { version: '1.0.0' }));

    expect(() =>
      graph({
        name: 'consumer',
        nodes: [
          subgraph(parsed, {
            id: 'research',
            inputs: { topic: 'not_declared' },
            outputs: { out: 'result' },
            writes: 'result',
          }),
        ],
      }),
    ).toThrow(GraphSpecError);
  });

  it('resolves a bundled grandchild through the embedded closure', async () => {
    const grandchild = researchGraph();
    const middle = graph({
      name: 'middle',
      nodes: [
        subgraph(grandchild, {
          id: 'call-leaf',
          reads: ['goal_in'],
          writes: 'out',
          inputs: { goal_in: 'goal_in' },
          outputs: { out: 'out' },
        }),
      ],
      inputs: { goal_in: z.string() },
      outputs: { out: z.string() },
    });
    const parsed = roundTrip(bundle(middle, { version: '2.0.0' }));
    const parent = graph({
      name: 'consumer',
      nodes: [
        subgraph(parsed, {
          id: 'call-middle',
          reads: ['topic'],
          writes: 'result',
          inputs: { topic: 'goal_in' },
          outputs: { out: 'result' },
        }),
      ],
    });

    const memory = await run(parent, { goal: 'nested', memory: { topic: 'volcanoes' } });

    expect(memory.result).toBe('from:worker');
  });

  it('runs a locally assembled bundle through its original stashes', async () => {
    const local = bundle(researchGraph(), { version: '1.0.0' });
    const parent = graph({
      name: 'consumer',
      nodes: [
        subgraph(local, {
          id: 'research',
          reads: ['topic'],
          writes: 'result',
          inputs: { topic: 'goal_in' },
          outputs: { out: 'result' },
        }),
      ],
    });

    const memory = await run(parent, { goal: 'local', memory: { topic: 'volcanoes' } });

    expect(memory.result).toBe('from:worker');
  });
});
