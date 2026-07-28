import { describe, test, expect, vi, beforeEach } from 'vitest';
import { executeToolNode } from '../src/runner/node-executors/tool.js';
import { NodeConfigError } from '../src/runner/errors.js';
import { createTestState, makeNode, createSimpleGraph } from './helpers/factories.js';
import type { NodeExecutorContext } from '../src/runner/node-executors/context.js';

vi.mock('../src/utils/logger.js', () => ({
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
    test('throws NodeConfigError when tool_id is missing', async () => {
      const node = makeNode({ id: 'bad-node', type: 'tool' });
      // node has no tool_id

      await expect(
        executeToolNode(node, mockCtx.createStateView(node), 0, mockCtx),
      ).rejects.toThrow(NodeConfigError);
    });

    test('error includes node id and field name', async () => {
      const node = makeNode({ id: 'bad-node', type: 'tool' });

      await expect(
        executeToolNode(node, mockCtx.createStateView(node), 0, mockCtx),
      ).rejects.toThrow('tool node "bad-node" is missing tool_id');
    });
  });

  describe('tool not found', () => {
    test('throws NodeConfigError when resolveTools returns empty', async () => {
      const node = makeNode({ id: 'tool-node', type: 'tool', tool_id: 'missing_tool', tools: [] } as any);
      mockResolveTools.mockResolvedValue({});

      await expect(
        executeToolNode(node, mockCtx.createStateView(node), 0, mockCtx),
      ).rejects.toThrow(NodeConfigError);
    });

    test('throws NodeConfigError when tool is not in resolved set', async () => {
      const node = makeNode({ id: 'tool-node', type: 'tool', tool_id: 'missing_tool', tools: [] } as any);
      mockResolveTools.mockResolvedValue({ other_tool: { execute: vi.fn() } });

      await expect(
        executeToolNode(node, mockCtx.createStateView(node), 0, mockCtx),
      ).rejects.toThrow('resolvable tool "missing_tool"');
    });
  });

  describe('tool without execute function', () => {
    test('throws NodeConfigError when tool has no execute', async () => {
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
    test('returns update_memory action with result', async () => {
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

    test('passes stateView.memory as args to tool execute', async () => {
      const executeFn = vi.fn().mockResolvedValue('ok');
      const node = makeNode({ id: 'tool-node', type: 'tool', tool_id: 'my_tool', tools: [] } as any);
      mockResolveTools.mockResolvedValue({ my_tool: { execute: executeFn } });

      const stateView = mockCtx.createStateView(node);
      await executeToolNode(node, stateView, 0, mockCtx);

      expect(executeFn).toHaveBeenCalledWith(stateView.memory);
    });
  });

  describe('tainted result handling', () => {
    test('extracts result from tainted shape and updates taint registry', async () => {
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

    test('emits only the NEW taint entry on the wire (reducer appends to state)', async () => {
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
    test('stores result directly without taint registry update', async () => {
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

    test('handles string result without taint detection', async () => {
      const node = makeNode({ id: 'tool-node', type: 'tool', tool_id: 'my_tool', tools: [] } as any);
      mockResolveTools.mockResolvedValue({
        my_tool: { execute: vi.fn().mockResolvedValue('plain string') },
      });

      const action = await executeToolNode(node, mockCtx.createStateView(node), 0, mockCtx);

      expect(action.payload).toEqual({
        updates: { 'tool-node_result': 'plain string' },
      });
    });

    test('handles null result', async () => {
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

  describe('idempotency key format', () => {
    test('uses node_id:iteration_count:attempt format', async () => {
      const node = makeNode({ id: 'my-node', type: 'tool', tool_id: 'my_tool', tools: [] } as any);
      mockResolveTools.mockResolvedValue({
        my_tool: { execute: vi.fn().mockResolvedValue('ok') },
      });

      const action = await executeToolNode(node, mockCtx.createStateView(node), 2, mockCtx);

      expect(action.idempotency_key).toBe('my-node:3:2');
    });
  });

  describe('action metadata', () => {
    test('includes correct node_id, timestamp, and attempt', async () => {
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

    test('action has uuid id', async () => {
      const node = makeNode({ id: 'tool-node', type: 'tool', tool_id: 'my_tool', tools: [] } as any);
      mockResolveTools.mockResolvedValue({
        my_tool: { execute: vi.fn().mockResolvedValue('ok') },
      });

      const action = await executeToolNode(node, mockCtx.createStateView(node), 0, mockCtx);

      expect(action.id).toBe('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11');
    });
  });

  describe('tool sources from node config', () => {
    test('passes node.tools to resolveTools', async () => {
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

    test('defaults to empty array when node.tools is undefined', async () => {
      const node = makeNode({ id: 'tool-node', type: 'tool', tool_id: 'my_tool' } as any);
      // node.tools is not set
      mockResolveTools.mockResolvedValue({
        my_tool: { execute: vi.fn().mockResolvedValue('ok') },
      });

      await executeToolNode(node, mockCtx.createStateView(node), 0, mockCtx);

      expect(mockResolveTools).toHaveBeenCalledWith([], node.agent_id);
    });
  });

  describe('empty tools array', () => {
    test('still calls resolveTools with empty array', async () => {
      const node = makeNode({ id: 'tool-node', type: 'tool', tool_id: 'my_tool', tools: [] } as any);
      mockResolveTools.mockResolvedValue({
        my_tool: { execute: vi.fn().mockResolvedValue('ok') },
      });

      await executeToolNode(node, mockCtx.createStateView(node), 0, mockCtx);

      expect(mockResolveTools).toHaveBeenCalledWith([], node.agent_id);
    });
  });
});
