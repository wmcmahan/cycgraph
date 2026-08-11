import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeToolNode } from '../src/execution/nodes/tool.js';
import { NodeConfigError } from '../src/execution/errors.js';
import { createTestState, makeNode, createSimpleGraph } from './helpers/factories.js';
import type { NodeExecutorContext } from '../src/execution/nodes/context.js';

vi.mock('../src/observability/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('uuid', () => ({
  v4: () => 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
}));

describe('executeToolNode', () => {
  let mockResolveTools: ReturnType<typeof vi.fn>;
  let mockGetTaintRegistry: ReturnType<typeof vi.fn>;
  let mockCtx: NodeExecutorContext;
  const defaultMemory = { key: 'value', existing: 'data' };

  beforeEach(() => {
    mockResolveTools = vi.fn();
    mockGetTaintRegistry = vi.fn().mockReturnValue({});

    const state = createTestState();
    state.iteration_count = 3;

    mockCtx = {
      state,
      graph: createSimpleGraph(),
      createStateView: () => ({
        workflow_id: 'test-wf',
        run_id: 'test-run',
        goal: 'test goal',
        constraints: [],
        memory: { ...defaultMemory },
      }),
      deps: {
        resolveTools: mockResolveTools,
        getTaintRegistry: mockGetTaintRegistry,
        executeAgent: vi.fn(),
        executeSupervisor: vi.fn(),
        evaluateQualityExecutor: vi.fn(),
        loadAgent: vi.fn(),
        drainTaintEntries: vi.fn(),
      } as any,
    };
  });

  describe('missing tool_id', () => {
    it('throws NodeConfigError when tool_id is missing', async () => {
      const node = makeNode({ id: 'bad-node', type: 'tool' });

      await expect(
        executeToolNode(node, mockCtx.createStateView(node), 0, mockCtx),
      ).rejects.toThrow(NodeConfigError);
    });

    it('error includes node id and field name', async () => {
      const node = makeNode({ id: 'bad-node', type: 'tool' });

      await expect(
        executeToolNode(node, mockCtx.createStateView(node), 0, mockCtx),
      ).rejects.toThrow('tool node "bad-node" is missing tool_id');
    });
  });

  describe('tool not found', () => {
    it('throws NodeConfigError when resolveTools returns empty', async () => {
      const node = makeNode({ id: 'tool-node', type: 'tool', tool_id: 'missing_tool', tools: [] } as any);
      mockResolveTools.mockResolvedValue({});

      await expect(
        executeToolNode(node, mockCtx.createStateView(node), 0, mockCtx),
      ).rejects.toThrow(NodeConfigError);
    });

    it('throws NodeConfigError when tool is not in resolved set', async () => {
      const node = makeNode({ id: 'tool-node', type: 'tool', tool_id: 'missing_tool', tools: [] } as any);
      mockResolveTools.mockResolvedValue({ other_tool: { execute: vi.fn() } });

      await expect(
        executeToolNode(node, mockCtx.createStateView(node), 0, mockCtx),
      ).rejects.toThrow('resolvable tool "missing_tool"');
    });
  });

  describe('tool without execute function', () => {
    it('throws NodeConfigError when tool has no execute', async () => {
      const node = makeNode({ id: 'tool-node', type: 'tool', tool_id: 'no_exec', tools: [] } as any);
      mockResolveTools.mockResolvedValue({
        no_exec: { description: 'A tool', parameters: {} },
      });

      await expect(
        executeToolNode(node, mockCtx.createStateView(node), 0, mockCtx),
      ).rejects.toThrow(NodeConfigError);
    });
  });

  describe('successful execution', () => {
    it('returns update_memory action with result', async () => {
      const node = makeNode({ id: 'tool-node', type: 'tool', tool_id: 'my_tool', tools: [] } as any);
      mockResolveTools.mockResolvedValue({
        my_tool: { execute: vi.fn().mockResolvedValue('tool output') },
      });

      const action = await executeToolNode(node, mockCtx.createStateView(node), 1, mockCtx);

      expect(action.type).toBe('update_memory');
      expect(action.payload).toEqual({
        updates: { 'tool-node_result': 'tool output' },
      });
    });

    it('passes stateView.memory as args to tool execute', async () => {
      const executeFn = vi.fn().mockResolvedValue('ok');
      const node = makeNode({ id: 'tool-node', type: 'tool', tool_id: 'my_tool', tools: [] } as any);
      mockResolveTools.mockResolvedValue({ my_tool: { execute: executeFn } });

      const stateView = mockCtx.createStateView(node);
      await executeToolNode(node, stateView, 0, mockCtx);

      expect(executeFn).toHaveBeenCalledWith(stateView.memory);
    });
  });

  describe('tainted result handling', () => {
    it('extracts result from tainted shape and updates taint registry', async () => {
      const taintedResult = {
        result: 'external data',
        taint: { source: 'mcp', server: 'web-search' },
      };
      const node = makeNode({ id: 'tool-node', type: 'tool', tool_id: 'web_search', tools: [] } as any);
      mockResolveTools.mockResolvedValue({
        web_search: { execute: vi.fn().mockResolvedValue(taintedResult) },
      });
      const existingRegistry: Record<string, unknown> = {};
      mockGetTaintRegistry.mockReturnValue(existingRegistry);

      const action = await executeToolNode(node, mockCtx.createStateView(node), 0, mockCtx);

      expect(action.payload).toEqual({
        updates: {
          'tool-node_result': 'external data',
          '_taint_registry': { 'tool-node_result': { source: 'mcp', server: 'web-search' } },
        },
      });
    });

    it('emits only the NEW taint entry on the wire (reducer appends to state)', async () => {
      const taintedResult = { result: 'data', taint: { source: 'external' } };
      const node = makeNode({ id: 'tool-node', type: 'tool', tool_id: 'my_tool', tools: [] } as any);
      mockResolveTools.mockResolvedValue({
        my_tool: { execute: vi.fn().mockResolvedValue(taintedResult) },
      });

      const action = await executeToolNode(node, mockCtx.createStateView(node), 0, mockCtx);

      const updates = action.payload.updates as Record<string, unknown>;
      const registry = updates['_taint_registry'] as Record<string, unknown>;
      expect(Object.keys(registry)).toEqual(['tool-node_result']);
    });
  });

  describe('non-tainted result handling', () => {
    it('stores result directly without taint registry update', async () => {
      const node = makeNode({ id: 'tool-node', type: 'tool', tool_id: 'my_tool', tools: [] } as any);
      mockResolveTools.mockResolvedValue({
        my_tool: { execute: vi.fn().mockResolvedValue({ answer: 42 }) },
      });

      const action = await executeToolNode(node, mockCtx.createStateView(node), 0, mockCtx);

      expect(action.payload).toEqual({
        updates: { 'tool-node_result': { answer: 42 } },
      });
      expect(mockGetTaintRegistry).not.toHaveBeenCalled();
    });

    it('handles string result without taint detection', async () => {
      const node = makeNode({ id: 'tool-node', type: 'tool', tool_id: 'my_tool', tools: [] } as any);
      mockResolveTools.mockResolvedValue({
        my_tool: { execute: vi.fn().mockResolvedValue('plain string') },
      });

      const action = await executeToolNode(node, mockCtx.createStateView(node), 0, mockCtx);

      expect(action.payload).toEqual({
        updates: { 'tool-node_result': 'plain string' },
      });
    });

    it('handles null result', async () => {
      const node = makeNode({ id: 'tool-node', type: 'tool', tool_id: 'my_tool', tools: [] } as any);
      mockResolveTools.mockResolvedValue({
        my_tool: { execute: vi.fn().mockResolvedValue(null) },
      });

      const action = await executeToolNode(node, mockCtx.createStateView(node), 0, mockCtx);

      expect(action.payload).toEqual({
        updates: { 'tool-node_result': null },
      });
    });
  });

  describe('MCP-drained taint', () => {
    it('tags a plain result with drained MCP taint using the collected tool names', async () => {
      const node = makeNode({ id: 'tool-node', type: 'tool', tool_id: 'web_search', tools: [] } as any);
      mockResolveTools.mockResolvedValue({ web_search: { execute: vi.fn().mockResolvedValue('external data') } });
      (mockCtx.deps.drainTaintEntries as ReturnType<typeof vi.fn>).mockReturnValue(
        new Map([['web_search_result', { source: 'mcp_tool', tool_name: 'web_search', server_id: 'srv-1', created_at: 'now' }]]),
      );

      const action = await executeToolNode(node, mockCtx.createStateView(node), 0, mockCtx);

      const updates = action.payload.updates as Record<string, any>;
      expect(updates['tool-node_result']).toBe('external data');
      expect(updates['_taint_registry']['tool-node_result']).toMatchObject({
        source: 'mcp_tool',
        tool_name: 'web_search',
        server_id: 'srv-1',
      });
    });

    it('falls back to the tool_id when drained entries carry no tool names', async () => {
      const node = makeNode({ id: 'tool-node', type: 'tool', tool_id: 'my_tool', tools: [] } as any);
      mockResolveTools.mockResolvedValue({ my_tool: { execute: vi.fn().mockResolvedValue('data') } });
      (mockCtx.deps.drainTaintEntries as ReturnType<typeof vi.fn>).mockReturnValue(
        new Map([['tool-node_result', { source: 'mcp_tool', tool_name: undefined, server_id: 'srv-9', created_at: 'now' }]]),
      );

      const action = await executeToolNode(node, mockCtx.createStateView(node), 0, mockCtx);

      const updates = action.payload.updates as Record<string, any>;
      expect(updates['_taint_registry']['tool-node_result'].tool_name).toBe('my_tool');
    });

    it('leaves the result untainted when the drain yields no entries', async () => {
      const node = makeNode({ id: 'tool-node', type: 'tool', tool_id: 'my_tool', tools: [] } as any);
      mockResolveTools.mockResolvedValue({ my_tool: { execute: vi.fn().mockResolvedValue('data') } });
      (mockCtx.deps.drainTaintEntries as ReturnType<typeof vi.fn>).mockReturnValue(new Map());

      const action = await executeToolNode(node, mockCtx.createStateView(node), 0, mockCtx);

      expect((action.payload.updates as Record<string, unknown>)['_taint_registry']).toBeUndefined();
    });
  });

  describe('idempotency key format', () => {
    it('uses node_id:iteration_count:attempt format', async () => {
      const node = makeNode({ id: 'my-node', type: 'tool', tool_id: 'my_tool', tools: [] } as any);
      mockResolveTools.mockResolvedValue({
        my_tool: { execute: vi.fn().mockResolvedValue('ok') },
      });

      const action = await executeToolNode(node, mockCtx.createStateView(node), 2, mockCtx);

      expect(action.idempotency_key).toBe('my-node:3:2');
    });
  });

  describe('action metadata', () => {
    it('includes correct node_id, timestamp, and attempt', async () => {
      const node = makeNode({ id: 'tool-node', type: 'tool', tool_id: 'my_tool', tools: [] } as any);
      mockResolveTools.mockResolvedValue({
        my_tool: { execute: vi.fn().mockResolvedValue('ok') },
      });

      const action = await executeToolNode(node, mockCtx.createStateView(node), 5, mockCtx);

      expect(action.metadata).toEqual({
        node_id: 'tool-node',
        timestamp: expect.any(Date),
        attempt: 5,
      });
    });

    it('action has uuid id', async () => {
      const node = makeNode({ id: 'tool-node', type: 'tool', tool_id: 'my_tool', tools: [] } as any);
      mockResolveTools.mockResolvedValue({
        my_tool: { execute: vi.fn().mockResolvedValue('ok') },
      });

      const action = await executeToolNode(node, mockCtx.createStateView(node), 0, mockCtx);

      expect(action.id).toBe('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11');
    });
  });

  describe('tool sources from node config', () => {
    it('passes node.tools to resolveTools', async () => {
      const toolSources = [
        { type: 'mcp' as const, server_id: 'test-server' },
        { type: 'builtin' as const, name: 'save_to_memory' },
      ];
      const node = makeNode({
        id: 'tool-node',
        type: 'tool',
        tool_id: 'my_tool',
        tools: toolSources,
      } as any);
      mockResolveTools.mockResolvedValue({
        my_tool: { execute: vi.fn().mockResolvedValue('ok') },
      });

      await executeToolNode(node, mockCtx.createStateView(node), 0, mockCtx);

      expect(mockResolveTools).toHaveBeenCalledWith(toolSources, node.agent_id);
    });

    it('defaults to empty array when node.tools is undefined', async () => {
      const node = makeNode({ id: 'tool-node', type: 'tool', tool_id: 'my_tool' } as any);
      mockResolveTools.mockResolvedValue({
        my_tool: { execute: vi.fn().mockResolvedValue('ok') },
      });

      await executeToolNode(node, mockCtx.createStateView(node), 0, mockCtx);

      expect(mockResolveTools).toHaveBeenCalledWith([], node.agent_id);
    });
  });

  describe('empty tools array', () => {
    it('still calls resolveTools with empty array', async () => {
      const node = makeNode({ id: 'tool-node', type: 'tool', tool_id: 'my_tool', tools: [] } as any);
      mockResolveTools.mockResolvedValue({
        my_tool: { execute: vi.fn().mockResolvedValue('ok') },
      });

      await executeToolNode(node, mockCtx.createStateView(node), 0, mockCtx);

      expect(mockResolveTools).toHaveBeenCalledWith([], node.agent_id);
    });
  });
});
