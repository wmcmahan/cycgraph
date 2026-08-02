/**
 * executeMapNode + executeWorkerWithStateView — fan-out map-reduce node.
 */
import { describe, it, expect, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';

vi.mock('@ai-sdk/openai', () => ({ openai: vi.fn((m: string) => ({ provider: 'openai', modelId: m })) }));
vi.mock('@ai-sdk/anthropic', () => ({ anthropic: vi.fn((m: string) => ({ provider: 'anthropic', modelId: m })) }));
vi.mock('ai', () => ({ generateObject: vi.fn(), streamText: vi.fn() }));
vi.mock('@opentelemetry/api', () => ({
  trace: {
    getTracer: () => ({
      startActiveSpan: (_n: string, _o: any, fn: any) =>
        fn({ setAttribute: vi.fn(), setStatus: vi.fn(), recordException: vi.fn(), end: vi.fn() }),
    }),
  },
  SpanStatusCode: { OK: 0, ERROR: 2 },
  context: {},
}));

vi.mock('../src/agent/agent-executor/executor', () => ({
  executeAgent: vi.fn(async (agentId: string, stateView: any, _t: any, attempt: number) => {
    const item = stateView.taskContext?.map_item;
    return {
      id: uuidv4(),
      idempotency_key: uuidv4(),
      type: 'update_memory',
      payload: { updates: { [`${agentId}_result`]: `processed: ${JSON.stringify(item)}` } },
      metadata: {
        node_id: agentId, agent_id: agentId, timestamp: new Date(), attempt,
        token_usage: { totalTokens: 30 },
      },
    };
  }),
}));

vi.mock('../src/agent/supervisor-executor', () => ({ executeSupervisor: vi.fn() }));
vi.mock('../src/agent/evaluator', () => ({ evaluateQuality: vi.fn() }));
vi.mock('../src/agent/agent-factory', () => ({
  agentFactory: {
    loadAgent: vi.fn().mockResolvedValue({
      id: 'test', name: 'Test', model: 'gpt-4', provider: 'openai',
      system: 'test', temperature: 0.7, maxSteps: 10, tools: [],
      read_keys: ['*'], write_keys: ['*'],
    }),
    getModel: vi.fn().mockReturnValue({}),
  },
}));
vi.mock('../src/utils/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../src/utils/tracing', () => ({
  getTracer: () => ({}),
  withSpan: (_t: any, _n: string, fn: (s: any) => any) => fn({ setAttribute: vi.fn() }),
}));

import { GraphRunner } from '../src/runner/graph-runner.js';
import { executeMapNode, executeWorkerWithStateView } from '../src/runner/node-executors/map.js';
import type { Graph, GraphNode } from '../src/types/graph.js';
import type { WorkflowState, StateView, Action } from '../src/types/state.js';
import type { NodeExecutorContext, ExecutorDependencies } from '../src/runner/node-executors/context.js';

const createState = (memory: Record<string, unknown> = {}): WorkflowState => ({
  workflow_id: uuidv4(),
  run_id: uuidv4(),
  created_at: new Date(),
  updated_at: new Date(),
  goal: 'Map-reduce test',
  constraints: [],
  status: 'pending',
  iteration_count: 0,
  retry_count: 0,
  max_retries: 3,
  memory,
  visited_nodes: [],
  max_iterations: 50,
  compensation_stack: [],
  max_execution_time_ms: 3600000,
  total_tokens_used: 0,
  supervisor_history: [],
});

const createMapGraph = (config: any = {}): Graph => ({
  id: 'map-graph',
  name: 'Map-Reduce Test',
  description: 'Test map-reduce',
  nodes: [
    {
      id: 'mapper',
      type: 'map',
      map_reduce_config: {
        worker_node_id: 'worker',
        max_concurrency: 3,
        error_strategy: 'best_effort',
        ...config,
      },
      read_keys: ['*'],
      write_keys: ['*'],
      failure_policy: { max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 100, max_backoff_ms: 100 },
      requires_compensation: false,
    },
    {
      id: 'worker',
      type: 'agent',
      agent_id: 'worker-agent',
      read_keys: ['*'],
      write_keys: ['*'],
      failure_policy: { max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 100, max_backoff_ms: 100 },
      requires_compensation: false,
    },
    {
      id: 'synth',
      type: 'synthesizer',
      agent_id: 'synthesizer-agent',
      read_keys: ['*'],
      write_keys: ['*'],
      failure_policy: { max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 100, max_backoff_ms: 100 },
      requires_compensation: false,
    },
  ],
  edges: [
    { id: 'e1', source: 'mapper', target: 'synth', condition: { type: 'always' } },
  ],
  start_node: 'mapper',
  end_nodes: ['synth'],
});

describe('executeMapNode', () => {
  describe('via GraphRunner', () => {
    it('fans out static items to parallel workers', async () => {
      const runner = new GraphRunner(createMapGraph({ static_items: ['a', 'b', 'c'] }), createState());

      const finalState = await runner.run();

      expect(finalState.status).toBe('completed');
      expect((finalState.memory.mapper_results as any[]).length).toBe(3);
      expect(finalState.memory.mapper_count).toBe(3);
    });

    it('resolves items from a JSONPath query', async () => {
      const runner = new GraphRunner(createMapGraph({ items_path: '$.memory.items' }), createState({ items: ['x', 'y'] }));

      const finalState = await runner.run();

      expect(finalState.status).toBe('completed');
      expect(finalState.memory.mapper_count).toBe(2);
    });

    it('injects per-item context into each worker taskContext', async () => {
      const { executeAgent } = await import('../src/agent/agent-executor/executor.js');
      const capturedViews: any[] = [];
      (executeAgent as any).mockImplementation(async (agentId: string, stateView: any, _t: any, attempt: number) => {
        if (stateView.taskContext?.map_item !== undefined) capturedViews.push(stateView);
        return {
          id: uuidv4(),
          idempotency_key: uuidv4(),
          type: 'update_memory',
          payload: { updates: { [`${agentId}_result`]: 'ok' } },
          metadata: { node_id: agentId, agent_id: agentId, timestamp: new Date(), attempt, token_usage: { totalTokens: 30 } },
        };
      });

      await new GraphRunner(createMapGraph({ static_items: ['alpha', 'beta'] }), createState()).run();

      expect(capturedViews).toHaveLength(2);
      expect(capturedViews[0].taskContext).toEqual({ map_item: 'alpha', map_index: 0, map_total: 2 });
    });

    it('short-circuits an empty items list', async () => {
      const runner = new GraphRunner(createMapGraph({ static_items: [] }), createState());

      const finalState = await runner.run();

      expect(finalState.status).toBe('completed');
      expect(finalState.memory.mapper_results).toEqual([]);
      expect(finalState.memory.mapper_count).toBe(0);
    });

    it('collects worker failures in best_effort mode', async () => {
      const { executeAgent } = await import('../src/agent/agent-executor/executor.js');
      (executeAgent as any).mockImplementation(async (agentId: string, sv: any, _t: any, attempt: number) => {
        if (sv.taskContext?.map_index === 1) throw new Error('Worker failed');
        return {
          id: uuidv4(),
          idempotency_key: uuidv4(),
          type: 'update_memory',
          payload: { updates: { result: 'ok' } },
          metadata: { node_id: agentId, timestamp: new Date(), attempt, token_usage: { totalTokens: 10 } },
        };
      });

      const finalState = await new GraphRunner(
        createMapGraph({ static_items: ['a', 'b', 'c'], error_strategy: 'best_effort' }),
        createState(),
      ).run();

      expect(finalState.memory.mapper_count).toBe(2);
      expect(finalState.memory.mapper_error_count).toBe(1);
      expect((finalState.memory.mapper_errors as any[]).length).toBe(1);
    });

    it('fails loudly when static items exceed max_items', async () => {
      const runner = new GraphRunner(createMapGraph({ static_items: ['a', 'b', 'c'], max_items: 2 }), createState());

      await expect(runner.run()).rejects.toThrow(/at most 2 items/);
    });

    it('fails loudly when JSONPath-resolved items exceed max_items', async () => {
      const runner = new GraphRunner(createMapGraph({ items_path: '$.memory.items', max_items: 2 }), createState({ items: [1, 2, 3, 4, 5] }));

      await expect(runner.run()).rejects.toThrow(/at most 2 items/);
    });

    it('runs the downstream synthesizer after the mapper', async () => {
      const finalState = await new GraphRunner(createMapGraph({ static_items: ['a', 'b'] }), createState()).run();

      expect(finalState.status).toBe('completed');
      expect(finalState.memory.mapper_results).toBeDefined();
    });

    it('counts fan-out tokens exactly once (no double-count regression)', async () => {
      const { executeAgent } = await import('../src/agent/agent-executor/executor.js');
      (executeAgent as any).mockImplementation(async (agentId: string, stateView: any, _t: any, attempt: number) => {
        const item = stateView.taskContext?.map_item;
        return {
          id: uuidv4(),
          idempotency_key: uuidv4(),
          type: 'update_memory',
          payload: { updates: { [`${agentId}_result`]: `processed: ${JSON.stringify(item)}` } },
          metadata: { node_id: agentId, agent_id: agentId, timestamp: new Date(), attempt, token_usage: { totalTokens: 30 } },
        };
      });

      const finalState = await new GraphRunner(createMapGraph({ static_items: ['a', 'b', 'c'] }), createState()).run();

      expect(finalState.total_tokens_used).toBe(120);
    });

    it('re-surfaces worker taint onto aggregate keys (no taint laundering)', async () => {
      const { executeAgent } = await import('../src/agent/agent-executor/executor.js');
      (executeAgent as any).mockImplementation(async (agentId: string, stateView: any, _t: any, attempt: number) => {
        const item = stateView.taskContext?.map_item;
        const outKey = `${agentId}_result`;
        return {
          id: uuidv4(),
          idempotency_key: uuidv4(),
          type: 'update_memory',
          payload: {
            updates: {
              [outKey]: `processed: ${JSON.stringify(item)}`,
              _taint_registry: {
                [outKey]: { source: 'mcp_tool', tool_name: 'web_fetch', created_at: '2026-01-01T00:00:00.000Z' },
              },
            },
          },
          metadata: { node_id: agentId, agent_id: agentId, timestamp: new Date(), attempt, token_usage: { totalTokens: 1 } },
        };
      });

      const finalState = await new GraphRunner(createMapGraph({ static_items: ['a', 'b'] }), createState()).run();

      const registry = finalState.taint_registry as Record<string, unknown>;
      expect(registry).toBeDefined();
      expect(registry.mapper_results).toMatchObject({ source: 'derived' });
    });
  });

  describe('direct invocation', () => {
    const makeMapNode = (overrides: any = {}): GraphNode => ({
      id: 'mapper',
      type: 'map',
      map_reduce_config: {
        worker_node_id: 'worker',
        max_concurrency: 3,
        max_items: 1000,
        error_strategy: 'best_effort',
        ...overrides,
      },
      read_keys: ['*'],
      write_keys: ['*'],
      failure_policy: { max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 100, max_backoff_ms: 100 },
      requires_compensation: false,
    } as GraphNode);

    const workerNode: GraphNode = {
      id: 'worker',
      type: 'agent',
      agent_id: 'worker-agent',
      read_keys: ['*'],
      write_keys: ['*'],
      failure_policy: { max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 100, max_backoff_ms: 100 },
      requires_compensation: false,
    } as GraphNode;

    const makeStateView = (memory: Record<string, unknown> = {}): StateView => ({
      workflow_id: 'wf-1', run_id: 'run-1', goal: 'g', constraints: [], memory,
    });

    const makeDeps = (overrides: Partial<ExecutorDependencies> = {}): ExecutorDependencies => ({
      executeAgent: vi.fn(async (agentId: string, _sv: any, _t: any, attempt: number) => ({
        id: uuidv4(),
        idempotency_key: uuidv4(),
        type: 'update_memory',
        payload: { updates: { [`${agentId}_result`]: 'ok' } },
        metadata: { node_id: agentId, timestamp: new Date(), attempt, model: 'claude-sonnet-4-6', token_usage: { totalTokens: 5, inputTokens: 3, outputTokens: 2 } },
      })),
      executeSupervisor: vi.fn(),
      evaluateQualityExecutor: vi.fn(),
      resolveTools: vi.fn().mockResolvedValue({}),
      loadAgent: vi.fn().mockResolvedValue({ tools: [], write_keys: [] }),
      getTaintRegistry: vi.fn().mockReturnValue({}),
      ...overrides,
    });

    const makeCtx = (overrides: Partial<NodeExecutorContext> = {}): NodeExecutorContext => ({
      state: createState(),
      graph: { id: 'g-1', name: 'Test', nodes: [workerNode], edges: [], start_node: 'worker', metadata: {} } as any,
      createStateView: () => makeStateView(),
      deps: makeDeps(),
      ...overrides,
    });

    it('throws when map_reduce_config is missing', async () => {
      const node = { ...makeMapNode(), map_reduce_config: undefined } as GraphNode;

      await expect(executeMapNode(node, makeStateView(), 1, makeCtx())).rejects.toThrow('map_reduce_config');
    });

    it('throws when neither static_items nor items_path is provided', async () => {
      const node = makeMapNode({ worker_node_id: 'worker' });
      delete (node.map_reduce_config as any).static_items;
      delete (node.map_reduce_config as any).items_path;

      await expect(executeMapNode(node, makeStateView(), 1, makeCtx())).rejects.toThrow('static_items or items_path');
    });

    it('throws a config error when the items_path expression is malformed', async () => {
      const node = makeMapNode({ items_path: '$.memory.items[?(@.x' });

      await expect(executeMapNode(node, makeStateView({ items: [1, 2] }), 1, makeCtx())).rejects.toThrow(/valid items_path/);
    });

    it('throws when the worker node cannot be found', async () => {
      const node = makeMapNode({ static_items: ['a'], worker_node_id: 'missing' });

      await expect(executeMapNode(node, makeStateView(), 1, makeCtx())).rejects.toThrow('worker node');
    });

    it('captures the worker model into the aggregate action metadata', async () => {
      const node = makeMapNode({ static_items: ['a', 'b'] });

      const action = await executeMapNode(node, makeStateView(), 1, makeCtx());

      expect(action.metadata.model).toBe('claude-sonnet-4-6');
      expect(action.metadata.token_usage).toEqual({ totalTokens: 10, inputTokens: 6, outputTokens: 4 });
    });

    it('unwraps a JSONPath array result into the items list', async () => {
      const node = makeMapNode({ items_path: '$.memory.items' });

      const action = await executeMapNode(node, makeStateView({ items: ['a', 'b', 'c'] }), 1, makeCtx());

      expect(action.payload.updates!.mapper_count).toBe(3);
    });

    it('uses a flat JSONPath result directly when the first match is not an array', async () => {
      const node = makeMapNode({ items_path: '$.memory.items[*]' });

      const action = await executeMapNode(node, makeStateView({ items: ['a', 'b'] }), 1, makeCtx());

      expect(action.payload.updates!.mapper_count).toBe(2);
    });

    it('derives totalTokens from input+output when a worker omits totalTokens', async () => {
      const deps = makeDeps({
        executeAgent: vi.fn(async (agentId: string, _sv: any, _t: any, attempt: number) => ({
          id: uuidv4(),
          idempotency_key: uuidv4(),
          type: 'update_memory',
          payload: { updates: { [`${agentId}_result`]: 'ok' } },
          metadata: { node_id: agentId, timestamp: new Date(), attempt, token_usage: { inputTokens: 4, outputTokens: 6 } },
        })),
      });
      const node = makeMapNode({ static_items: ['a'] });

      const action = await executeMapNode(node, makeStateView(), 1, makeCtx({ deps }));

      expect(action.payload.total_tokens).toBe(10);
    });

    it('treats a worker with empty token_usage as zero tokens', async () => {
      const deps = makeDeps({
        executeAgent: vi.fn(async (agentId: string, _sv: any, _t: any, attempt: number) => ({
          id: uuidv4(),
          idempotency_key: uuidv4(),
          type: 'update_memory',
          payload: { updates: { [`${agentId}_result`]: 'ok' } },
          metadata: { node_id: agentId, timestamp: new Date(), attempt, token_usage: {} },
        })),
      });
      const node = makeMapNode({ static_items: ['a'] });

      const action = await executeMapNode(node, makeStateView(), 1, makeCtx({ deps }));

      expect(action.payload.total_tokens).toBe(0);
    });
  });
});

describe('executeWorkerWithStateView', () => {
  const makeStateView = (memory: Record<string, unknown> = {}): StateView => ({
    workflow_id: 'wf-1', run_id: 'run-1', goal: 'g', constraints: [], memory,
  });

  const makeDeps = (overrides: Partial<ExecutorDependencies> = {}): ExecutorDependencies => ({
    executeAgent: vi.fn().mockResolvedValue({
      id: 'a', idempotency_key: 'i', type: 'update_memory', payload: { updates: {} },
      metadata: { node_id: 'w', timestamp: new Date(), attempt: 1 },
    } as Action),
    executeSupervisor: vi.fn(),
    evaluateQualityExecutor: vi.fn(),
    resolveTools: vi.fn().mockResolvedValue({}),
    loadAgent: vi.fn().mockResolvedValue({ tools: [], write_keys: [] }),
    getTaintRegistry: vi.fn().mockReturnValue({}),
    ...overrides,
  });

  const makeCtx = (overrides: Partial<NodeExecutorContext> = {}): NodeExecutorContext => ({
    state: createState(),
    graph: { id: 'g-1', name: 'Test', nodes: [], edges: [], start_node: 's', metadata: {} } as any,
    createStateView: () => makeStateView(),
    deps: makeDeps(),
    ...overrides,
  });

  const agentNode = (overrides: Partial<GraphNode> = {}): GraphNode => ({
    id: 'worker', type: 'agent', agent_id: 'worker-agent', read_keys: ['*'], write_keys: ['*'],
    failure_policy: { max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 100, max_backoff_ms: 100 },
    requires_compensation: false, ...overrides,
  } as GraphNode);

  const toolNode = (overrides: Partial<GraphNode> = {}): GraphNode => ({
    id: 'tool-worker', type: 'tool', tool_id: 'fetch', read_keys: ['*'], write_keys: ['*'],
    failure_policy: { max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 100, max_backoff_ms: 100 },
    requires_compensation: false, ...overrides,
  } as GraphNode);

  it('throws when an agent worker has no agent_id', async () => {
    const node = agentNode({ agent_id: undefined });

    await expect(executeWorkerWithStateView(node, makeStateView(), 1, makeCtx())).rejects.toThrow('agent_id');
  });

  it('forwards default_write_key to executeAgent for an agent worker', async () => {
    const deps = makeDeps();
    const node = agentNode({ default_write_key: 'summary' });

    await executeWorkerWithStateView(node, makeStateView(), 1, makeCtx({ deps }));

    const callArgs = (deps.executeAgent as any).mock.calls[0][4];
    expect(callArgs.defaultWriteKey).toBe('summary');
  });

  it('runs a tool worker and writes its raw output to the result key', async () => {
    const execute = vi.fn().mockResolvedValue({ fetched: true });
    const deps = makeDeps({ resolveTools: vi.fn().mockResolvedValue({ fetch: { execute } }) });
    const node = toolNode({ tools: [{ type: 'builtin', name: 'fetch' }] as any });

    const action = await executeWorkerWithStateView(node, makeStateView({ k: 'v' }), 1, makeCtx({ deps }));

    expect(execute).toHaveBeenCalledWith({ k: 'v' });
    expect((action.payload.updates as Record<string, unknown>)['tool-worker_result']).toEqual({ fetched: true });
  });

  it('throws when a tool worker has no tool_id', async () => {
    const node = toolNode({ tool_id: undefined });

    await expect(executeWorkerWithStateView(node, makeStateView(), 1, makeCtx())).rejects.toThrow('tool_id');
  });

  it('throws when the named tool is not resolvable', async () => {
    const deps = makeDeps({ resolveTools: vi.fn().mockResolvedValue({}) });
    const node = toolNode();

    await expect(executeWorkerWithStateView(node, makeStateView(), 1, makeCtx({ deps }))).rejects.toThrow('resolvable tool');
  });

  it('throws for an unsupported worker node type', async () => {
    const node = { ...toolNode(), type: 'supervisor' } as unknown as GraphNode;

    await expect(executeWorkerWithStateView(node, makeStateView(), 1, makeCtx())).rejects.toThrow();
  });
});
