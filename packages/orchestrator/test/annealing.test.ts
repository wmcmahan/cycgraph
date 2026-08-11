/**
 * executeAnnealingLoop — temperature-annealed iterative refinement node.
 *
 * Exercised through GraphRunner (integration) and via direct calls (unit,
 * for the budget-guard, JSONPath-scoring, and no-iteration fallback
 * branches that the integration path cannot reach deterministically).
 */
import { describe, it, expect, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';

vi.mock('@ai-sdk/openai', () => ({ openai: vi.fn((m: string) => ({ provider: 'openai', modelId: m })) }));
vi.mock('@ai-sdk/anthropic', () => ({ anthropic: vi.fn((m: string) => ({ provider: 'anthropic', modelId: m })) }));
vi.mock('ai', () => ({
  generateObject: vi.fn(),
  generateText: vi.fn(),
  streamText: vi.fn(),
  isStepCount: vi.fn().mockReturnValue(() => false),
  tool: vi.fn((def: any) => def),
  jsonSchema: vi.fn((schema: any) => schema),
  Output: { object: vi.fn().mockReturnValue({}) },
}));
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

let agentCallCount = 0;
vi.mock('../src/agents/executors/agent/executor', () => ({
  executeAgent: vi.fn(async (agentId: string, stateView: any, _t: any, attempt: number) => {
    agentCallCount++;
    const iter = stateView.taskContext?.annealing_iteration ?? 0;
    const score = Math.min(0.3 + iter * 0.25, 1.0);
    return {
      id: uuidv4(),
      idempotency_key: uuidv4(),
      type: 'update_memory',
      payload: { updates: { [`${agentId}_result`]: `Iteration ${iter} output`, score } },
      metadata: {
        node_id: agentId, agent_id: agentId, timestamp: new Date(), attempt,
        token_usage: { totalTokens: 50 },
      },
    };
  }),
}));

const mockEvaluateQuality = vi.fn();
vi.mock('../src/agents/executors/evaluator/executor', () => ({
  evaluateQualityExecutor: (...args: any[]) => mockEvaluateQuality(...args),
}));

vi.mock('../src/agents/executors/supervisor', () => ({ executeSupervisor: vi.fn() }));
vi.mock('../src/agents/factory', () => ({
  agentFactory: {
    loadAgent: vi.fn().mockResolvedValue({
      id: 'test', name: 'Test', model: 'gpt-4', provider: 'openai',
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
import { executeAnnealingLoop } from '../src/execution/nodes/annealing.js';
import type { Graph, GraphNode } from '../src/graph/graph.js';
import type { WorkflowState, StateView, Action } from '../src/state/state.js';
import type { NodeExecutorContext, ExecutorDependencies } from '../src/execution/nodes/context.js';

const createState = (): WorkflowState => ({
  workflow_id: uuidv4(),
  run_id: uuidv4(),
  created_at: new Date(),
  updated_at: new Date(),
  goal: 'Annealing test',
  constraints: [],
  status: 'pending',
  iteration_count: 0,
  retry_count: 0,
  max_retries: 3,
  memory: {},
  visited_nodes: [],
  max_iterations: 50,
  compensation_stack: [],
  max_execution_time_ms: 3600000,
  total_tokens_used: 0,
  supervisor_history: [],
});

const createAnnealingGraph = (config: any = {}): Graph => ({
  id: 'annealing-graph',
  name: 'Annealing Test',
  description: 'Test self-annealing',
  nodes: [{
    id: 'annealing-agent',
    type: 'agent',
    agent_id: 'writer',
    annealing_config: {
      score_path: '$.updates.score',
      threshold: 0.8,
      max_iterations: 5,
      initial_temperature: 1.0,
      final_temperature: 0.2,
      diminishing_returns_delta: 0.02,
      ...config,
    },
    read_keys: ['*'],
    write_keys: ['*'],
    failure_policy: { max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 100, max_backoff_ms: 100 },
    requires_compensation: false,
  }],
  edges: [],
  start_node: 'annealing-agent',
  end_nodes: ['annealing-agent'],
});

describe('executeAnnealingLoop', () => {
  describe('via GraphRunner', () => {
    it('iterates until the quality threshold is met', async () => {
      agentCallCount = 0;
      const runner = new GraphRunner(createAnnealingGraph({ threshold: 0.8 }), createState());

      const finalState = await runner.run();

      expect(finalState.status).toBe('completed');
      expect(agentCallCount).toBe(3);
    });

    it('stops at max_iterations when the threshold is never met', async () => {
      agentCallCount = 0;
      const runner = new GraphRunner(createAnnealingGraph({ threshold: 0.99, max_iterations: 3 }), createState());

      const finalState = await runner.run();

      expect(finalState.status).toBe('completed');
      expect(agentCallCount).toBe(3);
    });

    it('scores iterations with the evaluator agent when configured', async () => {
      agentCallCount = 0;
      let evalCalls = 0;
      mockEvaluateQuality.mockImplementation(async () => {
        evalCalls++;
        return { score: evalCalls >= 2 ? 0.9 : 0.5, reasoning: 'test', tokensUsed: 20 };
      });
      const runner = new GraphRunner(
        createAnnealingGraph({ evaluator_agent_id: 'eval-agent', threshold: 0.85, max_iterations: 5 }),
        createState(),
      );

      const finalState = await runner.run();

      expect(finalState.status).toBe('completed');
      expect(evalCalls).toBe(2);
    });

    it('accumulates token usage across iterations', async () => {
      agentCallCount = 0;
      const runner = new GraphRunner(createAnnealingGraph({ threshold: 0.8 }), createState());

      const finalState = await runner.run();

      expect(finalState.total_tokens_used).toBeGreaterThanOrEqual(150);
    });

    it('interpolates temperature from initial to final across iterations', async () => {
      const { executeAgent } = await import('../src/agents/executors/agent/executor.js');
      (executeAgent as any).mockClear();
      const runner = new GraphRunner(
        createAnnealingGraph({ threshold: 0.99, max_iterations: 2, initial_temperature: 1.0, final_temperature: 0.2 }),
        createState(),
      );

      await runner.run();

      const calls = (executeAgent as any).mock.calls;
      expect(calls[0][4].temperatureOverride).toBeCloseTo(1.0, 5);
      expect(calls[calls.length - 1][4].temperatureOverride).toBeCloseTo(0.2, 5);
    });

    it('stops early when improvement falls below the diminishing-returns delta', async () => {
      agentCallCount = 0;
      const runner = new GraphRunner(
        createAnnealingGraph({ threshold: 0.99, max_iterations: 10, diminishing_returns_delta: 0.5 }),
        createState(),
      );

      await runner.run();

      expect(agentCallCount).toBeLessThan(10);
    });

    it('injects the annealing iteration and temperature into the agent taskContext', async () => {
      const { executeAgent } = await import('../src/agents/executors/agent/executor.js');
      (executeAgent as any).mockClear();
      const runner = new GraphRunner(createAnnealingGraph({ max_iterations: 2, threshold: 0.99 }), createState());

      await runner.run();

      const stateView = (executeAgent as any).mock.calls[0][1];
      expect(stateView.taskContext?.annealing_iteration).toBe(0);
      expect(stateView.taskContext?.annealing_temperature).toBeDefined();
    });
  });

  describe('direct invocation', () => {
    const makeNode = (config: any = {}, overrides: Partial<GraphNode> = {}): GraphNode => ({
      id: 'anneal',
      type: 'agent',
      agent_id: 'writer',
      annealing_config: {
        score_path: '$.updates.score',
        threshold: 0.99,
        max_iterations: 3,
        initial_temperature: 1.0,
        final_temperature: 0.2,
        diminishing_returns_delta: 0,
        ...config,
      },
      read_keys: ['*'],
      write_keys: ['*'],
      failure_policy: { max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 100, max_backoff_ms: 100 },
      requires_compensation: false,
      ...overrides,
    } as GraphNode);

    const makeStateView = (): StateView => ({
      workflow_id: 'wf-1', run_id: 'run-1', goal: 'g', constraints: [], memory: {},
    });

    const voterAction = (updates: Record<string, unknown>, metadata: Record<string, unknown> = {}): Action => ({
      id: uuidv4(),
      idempotency_key: uuidv4(),
      type: 'update_memory',
      payload: { updates },
      metadata: { node_id: 'anneal', timestamp: new Date(), attempt: 1, token_usage: { totalTokens: 50 }, ...metadata },
    } as Action);

    const makeDeps = (overrides: Partial<ExecutorDependencies> = {}): ExecutorDependencies => ({
      executeAgent: vi.fn(async () => voterAction({ score: 0.5 })),
      executeSupervisor: vi.fn(),
      evaluateQualityExecutor: vi.fn(),
      resolveTools: vi.fn().mockResolvedValue({}),
      loadAgent: vi.fn().mockResolvedValue({ tools: [], write_keys: [], provider: 'anthropic', model: 'claude-sonnet-4-6' }),
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

    it('stops before the next iteration once the node token budget is reached', async () => {
      const deps = makeDeps({ executeAgent: vi.fn(async () => voterAction({ score: 0.5 }, { token_usage: { totalTokens: 50 } })) });
      const node = makeNode({ max_iterations: 5 }, { budget: { max_tokens: 40 } } as any);

      await executeAnnealingLoop(node, makeStateView(), 1, makeCtx({ deps }));

      expect(deps.executeAgent).toHaveBeenCalledTimes(1);
    });

    it('scores zero when the score_path expression is malformed', async () => {
      const deps = makeDeps({ executeAgent: vi.fn(async () => voterAction({ score: 0.9 })) });
      const node = makeNode({ score_path: '$.updates[(@', max_iterations: 1 });

      const result = await executeAnnealingLoop(node, makeStateView(), 1, makeCtx({ deps }));

      expect((result.payload.updates as Record<string, unknown>).score).toBe(0.9);
    });

    it('scores zero when the score_path resolves to a non-number', async () => {
      const deps = makeDeps({ executeAgent: vi.fn(async () => voterAction({ score: 'high' })) });
      const node = makeNode({ max_iterations: 1 });

      const result = await executeAnnealingLoop(node, makeStateView(), 1, makeCtx({ deps }));

      expect((result.payload.updates as Record<string, unknown>).score).toBe('high');
    });

    it('records the first reported model across iterations', async () => {
      const deps = makeDeps({
        executeAgent: vi.fn(async (_id: string, sv: any) => {
          const iter = sv.taskContext?.annealing_iteration ?? 0;
          return voterAction({ score: iter === 0 ? 0.5 : 0.4 }, { model: 'claude-anneal-model' });
        }),
      });
      const node = makeNode({ max_iterations: 2 });

      await executeAnnealingLoop(node, makeStateView(), 1, makeCtx({ deps }));

      expect(deps.executeAgent).toHaveBeenCalledTimes(2);
    });

    it('skips the best-result update when a later iteration scores lower', async () => {
      const deps = makeDeps({
        executeAgent: vi.fn(async (_id: string, sv: any) => {
          const iter = sv.taskContext?.annealing_iteration ?? 0;
          return voterAction({ score: iter === 0 ? 0.6 : 0.2 });
        }),
      });
      const node = makeNode({ max_iterations: 2 });

      const result = await executeAnnealingLoop(node, makeStateView(), 1, makeCtx({ deps }));

      expect((result.payload.updates as Record<string, unknown>).score).toBe(0.6);
    });

    it('treats a missing token_usage as zero tokens for the iteration', async () => {
      const deps = makeDeps({ executeAgent: vi.fn(async () => voterAction({ score: 0.5 }, { token_usage: undefined })) });
      const node = makeNode({ max_iterations: 1 });

      const result = await executeAnnealingLoop(node, makeStateView(), 1, makeCtx({ deps }));

      expect(result.metadata.token_usage).toEqual({ totalTokens: 0, inputTokens: 0, outputTokens: 0 });
    });

    it('forwards a resolved modelOverride to the agent', async () => {
      const deps = makeDeps({
        loadAgent: vi.fn().mockResolvedValue({ tools: [], write_keys: [], provider: 'anthropic', model: 'claude-sonnet-4-6', model_preference: 'high' }),
      });
      const ctx = makeCtx({
        deps,
        modelResolver: (() => ({ model: 'claude-opus-4-8', reason: 'high-tier' })) as any,
        remainingBudgetUsd: 100,
      });
      const node = makeNode({ max_iterations: 1 });

      await executeAnnealingLoop(node, makeStateView(), 1, ctx);

      expect((deps.executeAgent as any).mock.calls[0][4].modelOverride).toBe('claude-opus-4-8');
    });

    it('forwards default_write_key as defaultWriteKey', async () => {
      const deps = makeDeps();
      const node = makeNode({ max_iterations: 1 }, { default_write_key: 'summary' } as any);

      await executeAnnealingLoop(node, makeStateView(), 1, makeCtx({ deps }));

      expect((deps.executeAgent as any).mock.calls[0][4].defaultWriteKey).toBe('summary');
    });

    it('returns an empty no-op action when no iteration runs', async () => {
      const deps = makeDeps();
      const node = makeNode({ max_iterations: 0 });

      const result = await executeAnnealingLoop(node, makeStateView(), 1, makeCtx({ deps }));

      expect(deps.executeAgent).not.toHaveBeenCalled();
      expect(result.payload.updates).toEqual({});
      expect(result.metadata.token_usage).toEqual({ totalTokens: 0, inputTokens: 0, outputTokens: 0 });
    });
  });
});
