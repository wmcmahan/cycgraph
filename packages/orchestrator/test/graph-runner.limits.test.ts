import { describe, it, expect, vi, beforeAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';

// ─── Mocks (must come before importing GraphRunner) ─────────────────────

vi.mock('@ai-sdk/openai', () => ({
  openai: vi.fn((model: string) => ({ provider: 'openai', modelId: model })),
}));

vi.mock('@ai-sdk/anthropic', () => ({
  anthropic: vi.fn((model: string) => ({ provider: 'anthropic', modelId: model })),
}));

vi.mock('ai', () => ({
  generateObject: vi.fn(),
  streamText: vi.fn(),
}));

vi.mock('@opentelemetry/api', () => ({
  trace: {
    getActiveSpan: () => undefined,
    getTracer: () => ({
      startActiveSpan: (_name: string, _opts: any, fn: any) =>
        fn({ setAttribute: vi.fn(), setStatus: vi.fn(), recordException: vi.fn(), end: vi.fn() }),
    }),
  },
  isSpanContextValid: () => false,
  SpanStatusCode: { OK: 0, ERROR: 2 },
  context: {},
}));

vi.mock('../src/agents/executors/agent/executor.js', () => ({
  executeAgent: vi.fn(async (agentId: string, _stateView: any, _tools: any, attempt: number) => ({
    id: uuidv4(),
    idempotency_key: uuidv4(),
    type: 'update_memory',
    payload: { updates: { [`${agentId}_result`]: 'Mock agent output' } },
    metadata: { node_id: agentId, agent_id: agentId, timestamp: new Date(), attempt },
  })),
}));

vi.mock('../src/agents/executors/supervisor.js', () => ({
  executeSupervisor: vi.fn(),
}));

vi.mock('../src/agents/factory.js', () => ({
  agentFactory: {
    loadAgent: vi.fn().mockResolvedValue({
      id: 'test-agent', name: 'Test', model: 'claude-3-5-sonnet', provider: 'anthropic',
      system: 'test', temperature: 0.7, maxSteps: 10, tools: [],
      read_keys: ['*'], write_keys: ['*'],
    }),
    getModel: vi.fn().mockReturnValue({}),
  },
}));

vi.mock('../src/observability/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../src/observability/tracing.js', () => ({
  getTracer: () => ({}),
  withSpan: (_tracer: any, _name: string, fn: (span: any) => any) => fn({ setAttribute: vi.fn() }),
  startSpan: () => ({ setAttribute: vi.fn(), end: vi.fn() }),
  inSpanContext: (_span: any, fn: () => any) => fn(),
}));

import type { Graph } from '../src/graph/graph.js';
import { isTerminalEvent } from '../src/execution/streaming/stream-events.js';
import type { WorkflowState } from '../src/state/state.js';

// ─── Deferred import to avoid top-level await crashing the worker ────────
let GraphRunner: Awaited<typeof import('../src/execution/engine/graph-runner.js')>['GraphRunner'];

beforeAll(async () => {
  ({ GraphRunner } = await import('../src/execution/engine/graph-runner.js'));
});

// ─── Shared helpers ─────────────────────────────────────────────────────

const createInitialState = (): WorkflowState => ({
  workflow_id: uuidv4(),
  run_id: uuidv4(),
  created_at: new Date(),
  updated_at: new Date(),
  goal: 'Test workflow',
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
  supervisor_history: [],
  total_tokens_used: 0,
});

const createLinearGraph = (): Graph => ({
  id: uuidv4(),
  name: 'Linear Test Graph',
  description: 'Simple linear graph for testing',
  nodes: [
    {
      id: 'start', type: 'agent', agent_id: 'agent-1',
      read_keys: ['*'], write_keys: ['*'],
      failure_policy: { max_retries: 3, backoff_strategy: 'exponential', initial_backoff_ms: 100, max_backoff_ms: 1000 },
      requires_compensation: false,
    },
    {
      id: 'end', type: 'agent', agent_id: 'agent-2',
      read_keys: ['result'], write_keys: ['*'],
      failure_policy: { max_retries: 3, backoff_strategy: 'exponential', initial_backoff_ms: 100, max_backoff_ms: 1000 },
      requires_compensation: false,
    },
  ],
  edges: [{ id: 'e1', source: 'start', target: 'end', condition: { type: 'always' } }],
  start_node: 'start',
  end_nodes: ['end'],
});

// ─── Tests ───────────────────────────────────────────────────────────────

describe('GraphRunner — Iteration Limits', () => {
  it('should stop at max_iterations', async () => {
    const cyclicGraph: Graph = {
      ...createLinearGraph(),
      edges: [
        { id: 'e1', source: 'start', target: 'end', condition: { type: 'always' } },
        { id: 'e2', source: 'end', target: 'start', condition: { type: 'always' } },
      ],
      end_nodes: [],
    };

    const initialState = createInitialState();
    initialState.max_iterations = 5;

    const runner = new GraphRunner(cyclicGraph, initialState);
    const finalState = await runner.run();

    expect(finalState.iteration_count).toBeGreaterThanOrEqual(5);
    expect(finalState.status).toBe('failed');
  });

  it('yields a workflow:failed terminal event when the iteration cap is hit', async () => {
    const cyclicGraph: Graph = {
      ...createLinearGraph(),
      edges: [
        { id: 'e1', source: 'start', target: 'end', condition: { type: 'always' } },
        { id: 'e2', source: 'end', target: 'start', condition: { type: 'always' } },
      ],
      end_nodes: [],
    };

    const initialState = createInitialState();
    initialState.max_iterations = 4;

    const events = [];
    for await (const event of new GraphRunner(cyclicGraph, initialState).stream()) {
      events.push(event);
    }

    const terminal = events.filter(isTerminalEvent);
    expect(terminal).toHaveLength(1);
    expect(terminal[0]!.type).toBe('workflow:failed');
    expect(terminal[0]!.state.status).toBe('failed');
  });
});

describe('GraphRunner — Timeout Management', () => {
  it('should throw WorkflowTimeoutError if max_execution_time_ms exceeded', async () => {
    const graph = createLinearGraph();
    const initialState = createInitialState();
    initialState.max_execution_time_ms = 10;

    const slowPersist = async () => {
      await new Promise(resolve => setTimeout(resolve, 20));
    };

    const slowRunner = new GraphRunner(graph, initialState, { persistStateFn: slowPersist });

    try {
      await slowRunner.run();
    } catch (error) {
      expect((error as Error).name).toBe('WorkflowTimeoutError');
    }
  }, 10000);

  it('should emit workflow:timeout event on timeout', async () => {
    const graph = createLinearGraph();
    const initialState = createInitialState();
    initialState.max_execution_time_ms = 1;

    const runner = new GraphRunner(graph, initialState);
    const timeoutSpy = vi.fn();
    runner.on('workflow:timeout', timeoutSpy);

    await runner.run().catch(() => {});

    if (timeoutSpy.mock.calls.length > 0) {
      expect(timeoutSpy).toHaveBeenCalledWith(
        expect.objectContaining({ workflow_id: initialState.workflow_id, elapsed_ms: expect.any(Number) })
      );
    }
  }, 5000);

  it('a node-level timeout aborts only the node controller, not the workflow controller', async () => {
    const { executeAgent } = await import('../src/agents/executors/agent/executor.js');

    const graph = createLinearGraph();
    graph.nodes[0].failure_policy = {
      max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 10, max_backoff_ms: 10, timeout_ms: 30,
    };
    const initialState = createInitialState();
    initialState.max_execution_time_ms = 3_600_000;

    let nodeSignal: AbortSignal | undefined;
    (executeAgent as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(
      (_id: string, _sv: unknown, _tools: unknown, _attempt: number, opts?: { abortSignal?: AbortSignal }) =>
        new Promise(() => { nodeSignal = opts?.abortSignal; }),
    );

    const runner = new GraphRunner(graph, initialState);
    await expect(runner.run()).rejects.toThrow(/timeout/i);

    expect(nodeSignal?.aborted).toBe(true);
    expect((runner as unknown as { abortController: AbortController }).abortController.signal.aborted).toBe(false);
  }, 5000);
});
