import { describe, it, expect, vi, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { createTestState, makeNode } from './helpers/factories';


vi.mock('@ai-sdk/openai', () => ({ openai: vi.fn((m: string) => ({ provider: 'openai', modelId: m })) }));
vi.mock('@ai-sdk/anthropic', () => ({ anthropic: vi.fn((m: string) => ({ provider: 'anthropic', modelId: m })) }));
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return { ...actual, generateText: vi.fn(), streamText: vi.fn() };
});
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
vi.mock('../src/agents/executors/agent/executor.js', () => ({
  executeAgent: vi.fn(async (agentId: string, _sv: any, _t: any, attempt: number) => ({
    id: uuidv4(),
    idempotency_key: uuidv4(),
    type: 'update_memory',
    payload: { updates: { result: 'agent output' } },
    metadata: { node_id: agentId, agent_id: agentId, timestamp: new Date(), attempt, token_usage: { totalTokens: 10 } },
  })),
}));
vi.mock('../src/agents/executors/supervisor/executor.js', () => ({ executeSupervisor: vi.fn() }));
vi.mock('../src/agents/executors/evaluator/executor.js', () => ({ evaluateQualityExecutor: vi.fn() }));
vi.mock('../src/agents/factory', () => ({
  agentFactory: {
    loadAgent: vi.fn().mockResolvedValue({
      id: 'test-agent', name: 'Test', model: 'gpt-4', provider: 'openai',
      system: 'test', temperature: 0.7, maxSteps: 10, tools: [],
      read_keys: ['*'], write_keys: ['*'],
    }),
    getModel: vi.fn().mockReturnValue({}),
  },
}));
vi.mock('../src/observability/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../src/observability/tracing', () => ({
  getTracer: () => ({}),
  withSpan: (_t: any, _n: string, fn: (s: any) => any) => fn({ setAttribute: vi.fn() }),
}));

import { GraphRunner } from '../src/execution/engine/graph-runner.js';
import type { GraphRunnerMiddleware, MiddlewareContext } from '../src/execution/middleware/middleware.js';
import type { Graph } from '../src/graph/graph.js';
import type { WorkflowState, Action } from '../src/state/state.js';

const createGraph = (nodes?: any[]): Graph => ({
  id: 'mw-graph',
  name: 'Middleware Test',
  description: 'Test middleware hooks',
  nodes: nodes ?? [
    makeNode({ id: 'node-a', agent_id: 'test-agent', failure_policy: { max_retries: 1, backoff_strategy: 'fixed' as const, initial_backoff_ms: 100, max_backoff_ms: 100 } }),
  ],
  edges: [],
  start_node: nodes?.[0]?.id ?? 'node-a',
  end_nodes: [nodes?.[nodes.length - 1]?.id ?? 'node-a'],
});


describe('GraphRunner Middleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('no middleware — passthrough works', async () => {
    const graph = createGraph();
    const state = createTestState();
    const runner = new GraphRunner(graph, state, { middleware: [] });
    const result = await runner.run();
    expect(result.status).toBe('completed');
  });

  it('beforeNodeExecute receives correct context', async () => {
    const contexts: MiddlewareContext[] = [];
    const mw: GraphRunnerMiddleware = {
      beforeNodeExecute: async (ctx) => { contexts.push({ ...ctx }); },
    };

    const graph = createGraph();
    const state = createTestState();
    const runner = new GraphRunner(graph, state, { middleware: [mw] });
    await runner.run();

    expect(contexts.length).toBe(1);
    expect(contexts[0].node.id).toBe('node-a');
    expect(contexts[0].graph.id).toBe('mw-graph');
    expect(typeof contexts[0].iteration).toBe('number');
  });

  it('beforeNodeExecute short-circuit skips execution', async () => {
    const shortCircuitAction: Action = {
      id: uuidv4(),
      idempotency_key: uuidv4(),
      type: 'update_memory',
      payload: { updates: { cached: 'from middleware' } },
      metadata: { node_id: 'node-a', timestamp: new Date(), attempt: 1 },
    };

    const mw: GraphRunnerMiddleware = {
      beforeNodeExecute: async () => ({ shortCircuit: shortCircuitAction }),
    };

    const graph = createGraph();
    const state = createTestState();
    const runner = new GraphRunner(graph, state, { middleware: [mw] });
    const result = await runner.run();

    expect(result.status).toBe('completed');
    expect(result.memory.cached).toBe('from middleware');

    const { executeAgent } = await import('../src/agents/executors/agent/executor.js');
    expect(executeAgent).not.toHaveBeenCalled();
  });

  it('afterNodeExecute can transform action', async () => {
    const mw: GraphRunnerMiddleware = {
      afterNodeExecute: async (_ctx, action) => ({
        ...action,
        payload: { ...action.payload, updates: { ...action.payload.updates, injected: 'by middleware' } },
      }),
    };

    const graph = createGraph();
    const state = createTestState();
    const runner = new GraphRunner(graph, state, { middleware: [mw] });
    const result = await runner.run();

    expect(result.memory.injected).toBe('by middleware');
  });

  it('afterReduce is called with new state', async () => {
    const newStates: WorkflowState[] = [];
    const mw: GraphRunnerMiddleware = {
      afterReduce: async (_ctx, _action, newState) => {
        newStates.push({ ...newState } as WorkflowState);
      },
    };

    const graph = createGraph();
    const state = createTestState();
    const runner = new GraphRunner(graph, state, { middleware: [mw] });
    await runner.run();

    expect(newStates.length).toBe(1);
    expect(newStates[0].memory).toHaveProperty('result');
  });

  it('beforeAdvance can override routing', async () => {
    const fp = { max_retries: 1, backoff_strategy: 'fixed' as const, initial_backoff_ms: 100, max_backoff_ms: 100 };
    const graph: Graph = {
      id: 'route-graph',
      name: 'Route Test',
      description: 'Tests routing override',
      nodes: [
        makeNode({ id: 'start', agent_id: 'test-agent', failure_policy: fp }),
        makeNode({ id: 'default-next', agent_id: 'test-agent', failure_policy: fp }),
        makeNode({ id: 'override-target', agent_id: 'test-agent', failure_policy: fp }),
      ],
      edges: [{ source: 'start', target: 'default-next', condition: { type: 'always' as const } }],
      start_node: 'start',
      end_nodes: ['default-next', 'override-target'],
    };

    const mw: GraphRunnerMiddleware = {
      beforeAdvance: async (_ctx, nextNodeId) => {
        if (nextNodeId === 'default-next') return 'override-target';
      },
    };

    const state = createTestState();
    const runner = new GraphRunner(graph, state, { middleware: [mw] });
    const result = await runner.run();

    expect(result.visited_nodes).toContain('override-target');
    expect(result.visited_nodes).not.toContain('default-next');
  });

  it('multiple middleware execute in registration order', async () => {
    const order: string[] = [];

    const mw1: GraphRunnerMiddleware = {
      beforeNodeExecute: async () => { order.push('mw1-before'); },
      afterNodeExecute: async () => { order.push('mw1-after'); },
    };
    const mw2: GraphRunnerMiddleware = {
      beforeNodeExecute: async () => { order.push('mw2-before'); },
      afterNodeExecute: async () => { order.push('mw2-after'); },
    };

    const graph = createGraph();
    const state = createTestState();
    const runner = new GraphRunner(graph, state, { middleware: [mw1, mw2] });
    await runner.run();

    expect(order).toEqual(['mw1-before', 'mw2-before', 'mw1-after', 'mw2-after']);
  });

  it('first middleware short-circuit prevents later middleware from running', async () => {
    const order: string[] = [];

    const mw1: GraphRunnerMiddleware = {
      beforeNodeExecute: async () => {
        order.push('mw1');
        return {
          shortCircuit: {
            id: uuidv4(),
            idempotency_key: uuidv4(),
            type: 'update_memory',
            payload: { updates: { from: 'mw1' } },
            metadata: { node_id: 'node-a', timestamp: new Date(), attempt: 1 },
          },
        };
      },
    };
    const mw2: GraphRunnerMiddleware = {
      beforeNodeExecute: async () => { order.push('mw2'); },
    };

    const graph = createGraph();
    const state = createTestState();
    const runner = new GraphRunner(graph, state, { middleware: [mw1, mw2] });
    await runner.run();

    expect(order).toEqual(['mw1']);
  });

  it('middleware error propagates to runner error handling', async () => {
    const mw: GraphRunnerMiddleware = {
      beforeNodeExecute: async () => { throw new Error('middleware boom'); },
    };

    const graph = createGraph();
    const state = createTestState();
    const runner = new GraphRunner(graph, state, { middleware: [mw] });
    await expect(runner.run()).rejects.toThrow('middleware boom');
  });

  it('afterNodeExecute returning void keeps original action', async () => {
    const mw: GraphRunnerMiddleware = {
      afterNodeExecute: async () => { /* returns void */ },
    };

    const graph = createGraph();
    const state = createTestState();
    const runner = new GraphRunner(graph, state, { middleware: [mw] });
    const result = await runner.run();

    expect(result.status).toBe('completed');
    expect(result.memory.result).toBe('agent output');
  });

  it('beforeAdvance returning void keeps default routing', async () => {
    const fp = { max_retries: 1, backoff_strategy: 'fixed' as const, initial_backoff_ms: 100, max_backoff_ms: 100 };
    const graph: Graph = {
      id: 'route-graph',
      name: 'Route Test',
      description: 'Default routing',
      nodes: [
        makeNode({ id: 'start', agent_id: 'test-agent', failure_policy: fp }),
        makeNode({ id: 'expected-next', agent_id: 'test-agent', failure_policy: fp }),
      ],
      edges: [{ source: 'start', target: 'expected-next', condition: { type: 'always' as const } }],
      start_node: 'start',
      end_nodes: ['expected-next'],
    };

    const mw: GraphRunnerMiddleware = {
      beforeAdvance: async () => { /* returns void — keep default */ },
    };

    const state = createTestState();
    const runner = new GraphRunner(graph, state, { middleware: [mw] });
    const result = await runner.run();

    expect(result.visited_nodes).toContain('expected-next');
  });
});
