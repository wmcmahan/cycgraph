/**
 * Tests for computeRequirements (src/authoring/requirements.ts): the
 * generated half of a bundle manifest's `requires` block — custom tools,
 * MCP servers, and models collected across a facade composition's closure.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { agent } from '../src/authoring/agent.js';
import { node } from '../src/authoring/node.js';
import { subgraph } from '../src/authoring/subgraph.js';
import { graph } from '../src/authoring/graph.js';
import { computeRequirements, checkRequirements } from '../src/authoring/requirements.js';
import { bundle, parseBundle } from '../src/authoring/bundle.js';
import { tool } from '../src/tools/define-tool.js';
import { InMemoryMCPServerRegistry } from '../src/persistence/in-memory.js';
import { createProviderRegistry } from '../src/agents/providers/provider-registry.js';

describe('computeRequirements', () => {
  it('collects custom tools, mcp servers, and models from one graph', () => {
    const worker = node({
      id: 'worker',
      agent: agent({
        model: 'claude-sonnet-4-6',
        instructions: 'x',
        tools: ['lookup_order', { mcp: 'web-search' }],
      }),
      writes: 'out',
    });
    const g = graph({ name: 'g', nodes: [worker], edges: [] });

    expect(computeRequirements(g)).toEqual({
      tools: [{ name: 'lookup_order' }],
      mcpServers: [{ id: 'web-search' }],
      models: ['claude-sonnet-4-6'],
    });
  });

  it('excludes builtin tools from the requirement set', () => {
    const worker = node({
      id: 'worker',
      agent: agent({ model: 'claude-sonnet-4-6', instructions: 'x', tools: ['save_to_memory'] }),
      writes: 'out',
    });
    const g = graph({ name: 'g', nodes: [worker], edges: [] });

    expect(computeRequirements(g).tools).toEqual([]);
  });

  it('enriches a tool entry with schema and taint from an in-scope implementation', () => {
    const fetchPage = tool({
      name: 'fetch_page',
      description: 'Fetch a page',
      parameters: z.object({ url: z.string() }),
      execute: async () => 'html',
      taints: true,
    });
    const worker = node({
      id: 'worker',
      agent: agent({ model: 'claude-sonnet-4-6', instructions: 'x', tools: [fetchPage] }),
      writes: 'out',
    });
    const g = graph({ name: 'g', nodes: [worker], edges: [] });

    const requirements = computeRequirements(g);

    expect(requirements.tools).toEqual([
      {
        name: 'fetch_page',
        inputSchema: expect.objectContaining({ type: 'object' }),
        taints: true,
      },
    ]);
  });

  it('folds a subgraph child closure into the parent requirements', () => {
    const childWorker = node({
      id: 'child-worker',
      agent: agent({ model: 'claude-haiku-4-5-20251001', instructions: 'x', tools: [{ mcp: 'fetch' }] }),
      writes: 'out',
    });
    const child = graph({ name: 'child', nodes: [childWorker], edges: [] });
    const parentWorker = node({
      id: 'parent-worker',
      agent: agent({ model: 'claude-sonnet-4-6', instructions: 'x' }),
      writes: 'result',
    });
    const parent = graph({
      name: 'parent',
      nodes: [
        subgraph(child, { id: 'call', outputs: { out: 'raw' }, writes: 'raw' }),
        parentWorker,
      ],
      edges: [{ from: 'call', to: 'parent-worker' }],
    });

    expect(computeRequirements(parent)).toEqual({
      tools: [],
      mcpServers: [{ id: 'fetch' }],
      models: ['claude-haiku-4-5-20251001', 'claude-sonnet-4-6'],
    });
  });

  it('dedupes repeated tools, servers, and models across the closure', () => {
    const shared = agent({
      model: 'claude-sonnet-4-6',
      instructions: 'x',
      tools: ['lookup_order', { mcp: 'web-search' }],
    });
    const a = node({ id: 'a', agent: shared, writes: 'x1' });
    const b = node({ id: 'b', agent: agent({ model: 'claude-sonnet-4-6', instructions: 'y', tools: ['lookup_order'] }), writes: 'x2' });
    const g = graph({ name: 'g', nodes: [a, b], edges: [{ from: 'a', to: 'b' }] });

    expect(computeRequirements(g)).toEqual({
      tools: [{ name: 'lookup_order' }],
      mcpServers: [{ id: 'web-search' }],
      models: ['claude-sonnet-4-6'],
    });
  });
});

describe('checkRequirements', () => {
  const lookupOrder = tool({
    name: 'lookup_order',
    description: 'look up',
    parameters: z.object({ id: z.string() }),
    execute: async () => 'ok',
  });

  function demandingGraph() {
    const worker = node({
      id: 'worker',
      agent: agent({
        model: 'claude-sonnet-4-6',
        instructions: 'x',
        tools: [lookupOrder, { mcp: 'web-search' }],
      }),
      writes: 'out',
    });
    return graph({ name: 'demanding', nodes: [worker], edges: [] });
  }

  async function registryWith(id: string) {
    const servers = new InMemoryMCPServerRegistry();
    await servers.saveServer({
      id,
      name: id,
      transport: { type: 'stdio', command: 'npx', args: ['-y', 'srv'] },
    });
    return servers;
  }

  it('reports ok when every requirement is satisfied', async () => {
    const result = await checkRequirements(demandingGraph(), {
      tools: [lookupOrder],
      mcpServers: await registryWith('web-search'),
      providers: createProviderRegistry(),
    });

    expect(result).toEqual({ ok: true, missingTools: [], missingMcpServers: [], unknownModels: [] });
  });

  it('reports a required tool with no supplied implementation', async () => {
    const result = await checkRequirements(demandingGraph(), {
      mcpServers: await registryWith('web-search'),
    });

    expect(result.ok).toBe(false);
    expect(result.missingTools).toEqual(['lookup_order']);
  });

  it('reports required servers missing when no registry is supplied', async () => {
    const result = await checkRequirements(demandingGraph(), { tools: [lookupOrder] });

    expect(result.ok).toBe(false);
    expect(result.missingMcpServers).toEqual(['web-search']);
  });

  it('reports an unregistered server id', async () => {
    const result = await checkRequirements(demandingGraph(), {
      tools: [lookupOrder],
      mcpServers: await registryWith('some-other-server'),
    });

    expect(result.missingMcpServers).toEqual(['web-search']);
  });

  it('flags unknown models as advisory without failing the check', async () => {
    const worker = node({
      id: 'worker',
      agent: agent({ model: 'totally-made-up-model', provider: 'anthropic', instructions: 'x' }),
      writes: 'out',
    });
    const g = graph({ name: 'g', nodes: [worker], edges: [] });

    const result = await checkRequirements(g, { providers: createProviderRegistry() });

    expect(result.ok).toBe(true);
    expect(result.unknownModels).toEqual(['totally-made-up-model']);
  });

  it('checks a deserialized bundle through its manifest requires', async () => {
    const parsed = parseBundle(JSON.parse(JSON.stringify(bundle(demandingGraph(), { version: '1.0.0' }))));

    const missing = await checkRequirements(parsed, {});
    const satisfied = await checkRequirements(parsed, {
      tools: [lookupOrder],
      mcpServers: await registryWith('web-search'),
    });

    expect(missing.ok).toBe(false);
    expect(missing.missingTools).toEqual(['lookup_order']);
    expect(missing.missingMcpServers).toEqual(['web-search']);
    expect(satisfied.ok).toBe(true);
  });
});
