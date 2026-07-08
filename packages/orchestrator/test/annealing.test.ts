import { describe, test, expect, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';

// ─── Mocks ────────────────────────────────────────────────────────

vi.mock('@ai-sdk/openai', () => ({ openai: vi.fn((m: string) => ({ provider: 'openai', modelId: m })) }));
vi.mock('@ai-sdk/anthropic', () => ({ anthropic: vi.fn((m: string) => ({ provider: 'anthropic', modelId: m })) }));
vi.mock('ai', () => ({
  generateObject: vi.fn(),
  generateText: vi.fn(),
  streamText: vi.fn(),
  stepCountIs: vi.fn().mockReturnValue(() => false),
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
vi.mock('../src/agent/agent-executor/executor', () => ({
  executeAgent: vi.fn(async (agentId: string, stateView: any, _t: any, attempt: number, options?: any) => {
    agentCallCount++;
    const iter = stateView.memory._annealing_iteration ?? 0;
    // Simulate improving quality over iterations
    const score = Math.min(0.3 + iter * 0.25, 1.0);
    return {
      id: uuidv4(),
      idempotency_key: uuidv4(),
      type: 'update_memory',
      payload: {
        updates: {
          [`${agentId}_result`]: `Iteration ${iter} output`,
          score,
        },
      },
      metadata: {
        node_id: agentId, agent_id: agentId, timestamp: new Date(), attempt,
        token_usage: { totalTokens: 50 },
      },
    };
  }),
}));

const mockEvaluateQuality = vi.fn();
vi.mock('../src/agent/evaluator-executor/executor', () => ({
  evaluateQualityExecutor: (...args: any[]) => mockEvaluateQuality(...args),
}));

vi.mock('../src/agent/supervisor-executor', () => ({ executeSupervisor: vi.fn() }));
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
import type { Graph } from '../src/types/graph.js';
import type { WorkflowState } from '../src/types/state.js';

// ─── Helpers ──────────────────────────────────────────────────────

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

// ─── Tests ────────────────────────────────────────────────────────

describe('Self-Annealing Loops', () => {
  test('should iterate until threshold is met', async () => {
    agentCallCount = 0;
    const graph = createAnnealingGraph({ threshold: 0.8 });
    const state = createState();

    const runner = new GraphRunner(graph, state);
    const finalState = await runner.run();

    expect(finalState.status).toBe('completed');
    // Score reaches 0.8 at iteration 2 (0.3 + 2*0.25 = 0.8)
    expect(agentCallCount).toBe(3); // iterations 0, 1, 2
  });

  test('should stop at max_iterations', async () => {
    agentCallCount = 0;
    const graph = createAnnealingGraph({ threshold: 0.99, max_iterations: 3 });
    const state = createState();

    const runner = new GraphRunner(graph, state);
    const finalState = await runner.run();

    expect(finalState.status).toBe('completed');
    expect(agentCallCount).toBe(3);
  });

  test('should use evaluator agent when configured', async () => {
    agentCallCount = 0;
    let evalCalls = 0;
    mockEvaluateQuality.mockImplementation(async () => {
      evalCalls++;
      return { score: evalCalls >= 2 ? 0.9 : 0.5, reasoning: 'test', tokensUsed: 20 };
    });

    const graph = createAnnealingGraph({
      evaluator_agent_id: 'eval-agent',
      threshold: 0.85,
      max_iterations: 5,
    });
    const state = createState();

    const runner = new GraphRunner(graph, state);
    const finalState = await runner.run();

    expect(finalState.status).toBe('completed');
    expect(mockEvaluateQuality).toHaveBeenCalled();
    expect(evalCalls).toBe(2);
  });

  test('should track total tokens across iterations', async () => {
    agentCallCount = 0;
    const graph = createAnnealingGraph({ threshold: 0.8 });
    const state = createState();

    const runner = new GraphRunner(graph, state);
    const finalState = await runner.run();

    // 3 iterations × 50 tokens each = 150
    expect(finalState.total_tokens_used).toBeGreaterThanOrEqual(150);
  });

  test('should pass temperature override to agent', async () => {
    const { executeAgent } = await import('../src/agent/agent-executor/executor.js');
    (executeAgent as any).mockClear();

    const graph = createAnnealingGraph({
      threshold: 0.99,
      max_iterations: 2,
      initial_temperature: 1.0,
      final_temperature: 0.2,
    });
    const state = createState();

    const runner = new GraphRunner(graph, state);
    await runner.run();

    // Check that executeAgent was called with temperature options
    const calls = (executeAgent as any).mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(2);
    // First call should have initial temperature
    expect(calls[0][4].temperatureOverride).toBeCloseTo(1.0, 5);
    // Last call should have final temperature
    expect(calls[calls.length - 1][4].temperatureOverride).toBeCloseTo(0.2, 5);
  });

  test('should stop on diminishing returns', async () => {
    agentCallCount = 0;
    // With delta=0.5 and score improvements of 0.25, should stop after detecting low improvement
    const graph = createAnnealingGraph({
      threshold: 0.99,
      max_iterations: 10,
      diminishing_returns_delta: 0.5,
    });
    const state = createState();

    const runner = new GraphRunner(graph, state);
    const finalState = await runner.run();

    // Should stop early due to diminishing returns
    expect(agentCallCount).toBeLessThan(10);
  });

  test('should inject annealing context into stateView', async () => {
    const { executeAgent } = await import('../src/agent/agent-executor/executor.js');
    (executeAgent as any).mockClear();

    const graph = createAnnealingGraph({ max_iterations: 2, threshold: 0.99 });
    const state = createState();

    const runner = new GraphRunner(graph, state);
    await runner.run();

    // Check that the stateView passed to executeAgent contains annealing fields
    const firstCallStateView = (executeAgent as any).mock.calls[0][1];
    expect(firstCallStateView.memory._annealing_iteration).toBe(0);
    expect(firstCallStateView.memory._annealing_temperature).toBeDefined();
  });
});
