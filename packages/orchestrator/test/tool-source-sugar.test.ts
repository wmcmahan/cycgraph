/**
 * Tests for the tool-source authoring sugar (src/types/tools.ts):
 * ToolSourceInputSchema normalization and the wire-purity guarantees at
 * createGraph and agent-registry boundaries.
 */

import { describe, it, expect } from 'vitest';
import {
  ToolSourceInputSchema,
  normalizeToolSources,
} from '../src/types/tools.js';
import { createGraph } from '../src/types/graph.js';
import { InMemoryAgentRegistry } from '../src/persistence/in-memory.js';

describe('ToolSourceInputSchema', () => {
  it('normalizes a builtin name string to a builtin source', () => {
    expect(ToolSourceInputSchema.parse('save_to_memory')).toEqual({
      type: 'builtin',
      name: 'save_to_memory',
    });
  });

  it('normalizes an unknown name string to a custom source', () => {
    expect(ToolSourceInputSchema.parse('lookup_order')).toEqual({
      type: 'custom',
      name: 'lookup_order',
    });
  });

  it('normalizes an mcp shorthand with a tool filter', () => {
    expect(ToolSourceInputSchema.parse({ mcp: 'web-search', tools: ['search'] })).toEqual({
      type: 'mcp',
      server_id: 'web-search',
      tool_names: ['search'],
    });
  });

  it('normalizes an mcp shorthand without a filter', () => {
    expect(ToolSourceInputSchema.parse({ mcp: 'web-search' })).toEqual({
      type: 'mcp',
      server_id: 'web-search',
    });
  });

  it('accepts the camelCase-remapped filter key tool_names', () => {
    expect(ToolSourceInputSchema.parse({ mcp: 'web-search', tool_names: ['fetch'] })).toEqual({
      type: 'mcp',
      server_id: 'web-search',
      tool_names: ['fetch'],
    });
  });

  it('passes structured wire sources through unchanged', () => {
    const structured = { type: 'mcp' as const, server_id: 'web-search', tool_names: ['search'] };

    expect(ToolSourceInputSchema.parse(structured)).toEqual(structured);
  });

  it('rejects a custom name with an invalid charset', () => {
    expect(() => ToolSourceInputSchema.parse('bad name!')).toThrow();
  });
});

describe('normalizeToolSources', () => {
  it('normalizes a mixed sugar array to the wire union', () => {
    expect(
      normalizeToolSources(['save_to_memory', 'lookup_order', { mcp: 'web-search' }]),
    ).toEqual([
      { type: 'builtin', name: 'save_to_memory' },
      { type: 'custom', name: 'lookup_order' },
      { type: 'mcp', server_id: 'web-search' },
    ]);
  });
});

describe('createGraph tool-source sugar', () => {
  it('stores node tools in structured wire form regardless of authoring shape', () => {
    const graph = createGraph({
      name: 'sugar',
      description: 'tool sugar graph',
      nodes: [
        {
          id: 'worker',
          type: 'agent',
          agentId: '00000000-0000-0000-0000-000000000001',
          tools: ['save_to_memory', 'lookup_order', { mcp: 'web-search', tools: ['search'] }],
        },
      ],
      edges: [],
      startNode: 'worker',
      endNodes: ['worker'],
    });

    expect(graph.nodes[0].tools).toEqual([
      { type: 'builtin', name: 'save_to_memory' },
      { type: 'custom', name: 'lookup_order' },
      { type: 'mcp', server_id: 'web-search', tool_names: ['search'] },
    ]);
  });
});

describe('InMemoryAgentRegistry tool-source sugar', () => {
  it('normalizes sugar to wire form at the register boundary', async () => {
    const registry = new InMemoryAgentRegistry();
    const id = registry.register({
      name: 'Sugar Agent',
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      systemPrompt: 'test',
      tools: ['lookup_order', { mcp: 'web-search' }],
    });

    const stored = await registry.loadAgent(id);

    expect(stored?.tools).toEqual([
      { type: 'custom', name: 'lookup_order' },
      { type: 'mcp', server_id: 'web-search' },
    ]);
  });

  it('normalizes sugar on update as well', async () => {
    const registry = new InMemoryAgentRegistry();
    const id = registry.register({
      name: 'Sugar Agent',
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      systemPrompt: 'test',
      tools: [],
    });

    await registry.updateAgent(id, { tools: ['save_to_memory'] });

    const stored = await registry.loadAgent(id);
    expect(stored?.tools).toEqual([{ type: 'builtin', name: 'save_to_memory' }]);
  });
});
