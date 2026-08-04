/**
 * Tests for the composed tool resolution (src/tools/registry.ts): shape
 * discrimination of the GraphRunnerOptions.tools array, resolution across
 * the builtin/custom/MCP legs, race-free taint attribution, and the
 * GraphRunner preflight + tool-node integration built on top of it.
 */

import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import {
  composeToolResolution,
  ToolNotRegisteredError,
} from '../src/tools/registry.js';
import { defineTool, ToolDefinitionError } from '../src/tools/define-tool.js';
import type { ToolResolver } from '../src/mcp/connection-manager.js';
import type { TaintMetadata } from '../src/types/state.js';
import { GraphRunner } from '../src/runner/graph-runner.js';
import type { Graph } from '../src/types/graph.js';
import { createTestState, makeNode } from './helpers/factories.js';

function localTool(name: string, taints = false) {
  return defineTool({
    name,
    description: `Tool ${name}`,
    parameters: z.record(z.string(), z.unknown()),
    execute: async (args) => ({ tool: name, args }),
    taints,
  });
}

function fakeResolver(toolset: Record<string, unknown> = {}): ToolResolver & {
  resolveTools: ReturnType<typeof vi.fn>;
  closeAll: ReturnType<typeof vi.fn>;
} {
  return {
    resolveTools: vi.fn(async () => toolset),
    closeAll: vi.fn(async () => undefined),
  };
}

function serverNotFound(): Error {
  const err = new Error('server missing');
  err.name = 'MCPServerNotFoundError';
  return err;
}

describe('composeToolResolution', () => {
  it('discriminates defined tools from resolvers by shape', () => {
    const composed = composeToolResolution([localTool('lookup'), fakeResolver()]);

    expect([...composed.definedToolNames]).toEqual(['lookup']);
    expect(composed.hasResolver).toBe(true);
  });

  it('reports no resolver when only defined tools are registered', () => {
    const composed = composeToolResolution([localTool('lookup')]);

    expect(composed.hasResolver).toBe(false);
  });

  it('throws on duplicate defined tool names', () => {
    expect(() => composeToolResolution([localTool('dup'), localTool('dup')])).toThrow(
      ToolDefinitionError,
    );
  });

  it('throws on entries that are neither defined tools nor resolvers', () => {
    expect(() => composeToolResolution([{} as never])).toThrow(ToolDefinitionError);
  });
});

describe('ComposedToolResolution', () => {
  describe('resolveTools', () => {
    it('resolves builtin sources from the shared catalog', async () => {
      const composed = composeToolResolution([]);

      const tools = await composed.resolveTools([{ type: 'builtin', name: 'save_to_memory' }]);

      expect(Object.keys(tools)).toEqual(['save_to_memory']);
    });

    it('resolves custom sources to raw tool definitions', async () => {
      const composed = composeToolResolution([localTool('lookup')]);

      const tools = await composed.resolveTools([{ type: 'custom', name: 'lookup' }]);
      const lookup = tools.lookup as { description: string; execute: (a: unknown) => Promise<unknown> };

      expect(lookup.description).toBe('Tool lookup');
      await expect(lookup.execute({ q: 1 })).resolves.toEqual({ tool: 'lookup', args: { q: 1 } });
    });

    it('throws ToolNotRegisteredError for an unregistered custom source', async () => {
      const composed = composeToolResolution([]);

      await expect(
        composed.resolveTools([{ type: 'custom', name: 'ghost' }]),
      ).rejects.toThrow(ToolNotRegisteredError);
    });

    it('forwards the MCP batch with sources and agentId to the resolver', async () => {
      const resolver = fakeResolver({ web_search: { description: 'search' } });
      const composed = composeToolResolution([resolver]);
      const sources = [{ type: 'mcp' as const, server_id: 'web' }];

      const tools = await composed.resolveTools(sources, 'agent-1');

      expect(resolver.resolveTools).toHaveBeenCalledWith(sources, 'agent-1');
      expect(Object.keys(tools)).toEqual(['web_search']);
    });

    it('falls back to the next resolver when a server is not found', async () => {
      const first = fakeResolver();
      first.resolveTools.mockRejectedValueOnce(serverNotFound());
      const second = fakeResolver({ web_search: { description: 'search' } });
      const composed = composeToolResolution([first, second]);

      const tools = await composed.resolveTools([{ type: 'mcp', server_id: 'web' }]);

      expect(Object.keys(tools)).toEqual(['web_search']);
    });

    it('rethrows resolver errors that are not server-not-found', async () => {
      const first = fakeResolver();
      first.resolveTools.mockRejectedValueOnce(new Error('connection refused'));
      const composed = composeToolResolution([first, fakeResolver()]);

      await expect(
        composed.resolveTools([{ type: 'mcp', server_id: 'web' }]),
      ).rejects.toThrow('connection refused');
    });

    it('throws a clear error for MCP sources with no resolver registered', async () => {
      const composed = composeToolResolution([localTool('lookup')]);

      await expect(
        composed.resolveTools([{ type: 'mcp', server_id: 'web' }]),
      ).rejects.toThrow(/no ToolResolver is registered/);
    });

    it('prefixes MCP names shadowed by local tools with mcp__', async () => {
      const resolver = fakeResolver({ lookup: { description: 'remote lookup' } });
      const composed = composeToolResolution([localTool('lookup'), resolver]);

      const tools = await composed.resolveTools([
        { type: 'custom', name: 'lookup' },
        { type: 'mcp', server_id: 'web' },
      ]);

      expect(Object.keys(tools).sort()).toEqual(['lookup', 'mcp__lookup']);
      expect((tools.lookup as { description: string }).description).toBe('Tool lookup');
    });
  });

  describe('drainTaintEntries', () => {
    it('records custom_tool taint for taints: true tools', async () => {
      const composed = composeToolResolution([localTool('fetch', true)]);
      const tools = await composed.resolveTools([{ type: 'custom', name: 'fetch' }]);
      await (tools.fetch as { execute: (a: unknown) => Promise<unknown> }).execute({});

      const drained = composed.drainTaintEntries(tools);

      expect(drained.size).toBe(1);
      expect(drained.get('custom:fetch')).toEqual(
        expect.objectContaining({ source: 'custom_tool', tool_name: 'fetch' }),
      );
    });

    it('records taint on the error path too', async () => {
      const failing = defineTool({
        name: 'flaky',
        description: 'Always fails',
        parameters: z.record(z.string(), z.unknown()),
        execute: async () => {
          throw new Error('boom');
        },
        taints: true,
      });
      const composed = composeToolResolution([failing]);
      const tools = await composed.resolveTools([{ type: 'custom', name: 'flaky' }]);

      await expect(
        (tools.flaky as { execute: (a: unknown) => Promise<unknown> }).execute({}),
      ).rejects.toThrow('boom');
      expect(composed.drainTaintEntries(tools).get('custom:flaky')?.source).toBe('custom_tool');
    });

    it('records nothing for untainted custom tools', async () => {
      const composed = composeToolResolution([localTool('pure')]);
      const tools = await composed.resolveTools([{ type: 'custom', name: 'pure' }]);
      await (tools.pure as { execute: (a: unknown) => Promise<unknown> }).execute({});

      expect(composed.drainTaintEntries(tools).size).toBe(0);
    });

    it('isolates taint between concurrent resolutions', async () => {
      const composed = composeToolResolution([localTool('fetch', true)]);
      const source = [{ type: 'custom' as const, name: 'fetch' }];
      const toolsA = await composed.resolveTools(source);
      const toolsB = await composed.resolveTools(source);
      await (toolsA.fetch as { execute: (a: unknown) => Promise<unknown> }).execute({});

      expect(composed.drainTaintEntries(toolsB).size).toBe(0);
      expect(composed.drainTaintEntries(toolsA).size).toBe(1);
    });

    it('delegates part drains using the resolver leg toolset handle', async () => {
      const legToolset = { web_search: { description: 'search' } };
      const legEntry: TaintMetadata = {
        source: 'mcp_tool',
        tool_name: 'web_search',
        server_id: 'web',
        created_at: '2026-01-01T00:00:00Z',
      };
      const resolver: ToolResolver = {
        resolveTools: vi.fn(async () => legToolset),
        closeAll: vi.fn(async () => undefined),
        drainTaintEntries: vi.fn((tools?: Record<string, unknown>) =>
          tools === legToolset ? new Map([['web:web_search', legEntry]]) : new Map(),
        ),
      };
      const composed = composeToolResolution([resolver]);
      const merged = await composed.resolveTools([{ type: 'mcp', server_id: 'web' }]);

      const drained = composed.drainTaintEntries(merged);

      expect(resolver.drainTaintEntries).toHaveBeenCalledWith(legToolset);
      expect(drained.get('web:web_search')).toEqual(legEntry);
    });

    it('merges fallback and resolver drains for a no-arg drain', async () => {
      const resolver: ToolResolver = {
        resolveTools: vi.fn(async () => ({})),
        closeAll: vi.fn(async () => undefined),
        drainTaintEntries: vi.fn(() =>
          new Map<string, TaintMetadata>([
            ['web:x', { source: 'mcp_tool', tool_name: 'x', created_at: '2026-01-01T00:00:00Z' }],
          ]),
        ),
      };
      const composed = composeToolResolution([localTool('fetch', true), resolver]);
      const tools = await composed.resolveTools([{ type: 'custom', name: 'fetch' }]);
      await (tools.fetch as { execute: (a: unknown) => Promise<unknown> }).execute({});

      const drained = composed.drainTaintEntries();

      expect(drained.has('custom:fetch')).toBe(true);
      expect(drained.has('web:x')).toBe(true);
    });
  });

  describe('closeAll', () => {
    it('fans out to every resolver leg', async () => {
      const first = fakeResolver();
      const second = fakeResolver();
      const composed = composeToolResolution([first, localTool('lookup'), second]);

      await composed.closeAll();

      expect(first.closeAll).toHaveBeenCalledOnce();
      expect(second.closeAll).toHaveBeenCalledOnce();
    });
  });
});

describe('GraphRunner tool wiring', () => {
  function customToolGraph(toolName: string): Graph {
    return {
      id: uuidv4(),
      name: 'custom-tool-graph',
      description: 'single tool node using a custom tool',
      nodes: [
        makeNode({
          id: 'fetch',
          type: 'tool',
          tool_id: toolName,
          tools: [{ type: 'custom', name: toolName }],
          read_keys: ['goal'],
          write_keys: [],
        }),
      ],
      edges: [],
      start_node: 'fetch',
      end_nodes: ['fetch'],
      strict_taint: false,
    };
  }

  it('fails preflight when a custom source has no matching registration', async () => {
    const runner = new GraphRunner(customToolGraph('ghost'), createTestState(), {
      tools: [localTool('lookup')],
    });

    await expect(runner.run()).rejects.toThrow(/custom tool "ghost"/);
  });

  it('fails preflight for custom sources when no tools option is configured', async () => {
    const runner = new GraphRunner(customToolGraph('ghost'), createTestState());

    await expect(runner.run()).rejects.toThrow(/custom tool "ghost"/);
  });

  it('executes a tool node backed by a registered custom tool', async () => {
    const runner = new GraphRunner(customToolGraph('lookup'), createTestState(), {
      tools: [localTool('lookup')],
    });

    const finalState = await runner.run();

    expect(finalState.status).toBe('completed');
    expect(finalState.memory.fetch_result).toEqual(
      expect.objectContaining({ tool: 'lookup' }),
    );
  });

  it('routes custom_tool taint from a tainting tool into the taint registry', async () => {
    const runner = new GraphRunner(customToolGraph('scrape'), createTestState(), {
      tools: [localTool('scrape', true)],
    });

    const finalState = await runner.run();

    expect(finalState.taint_registry.fetch_result).toEqual(
      expect.objectContaining({ source: 'custom_tool' }),
    );
  });
});
