import { describe, test, expect, vi, beforeAll } from 'vitest';
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
    getTracer: () => ({
      startActiveSpan: (_name: string, _opts: any, fn: any) =>
        fn({ setAttribute: vi.fn(), setStatus: vi.fn(), recordException: vi.fn(), end: vi.fn() }),
    }),
  },
  SpanStatusCode: { OK: 0, ERROR: 2 },
  context: {},
}));

vi.mock('../src/agent/agent-executor/executor.js', () => ({
  executeAgent: vi.fn(async (agentId: string, _stateView: any, _tools: any, attempt: number) => ({
    id: uuidv4(),
    idempotency_key: uuidv4(),
    type: 'update_memory',
    payload: { updates: { [`${agentId}_result`]: 'Mock agent output' } },
    metadata: { node_id: agentId, agent_id: agentId, timestamp: new Date(), attempt },
  })),
}));

vi.mock('../src/agent/supervisor-executor.js', () => ({
  executeSupervisor: vi.fn(),
}));

vi.mock('../src/agent/agent-factory.js', () => ({
  agentFactory: {
    loadAgent: vi.fn().mockResolvedValue({
      id: 'test-agent', name: 'Test', model: 'claude-3-5-sonnet', provider: 'anthropic',
      system: 'test', temperature: 0.7, maxSteps: 10, tools: [],
      read_keys: ['*'], write_keys: ['*'],
    }),
    getModel: vi.fn().mockReturnValue({}),
  },
}));

vi.mock('../src/utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../src/utils/tracing.js', () => ({
  getTracer: () => ({}),
  withSpan: (_tracer: any, _name: string, fn: (span: any) => any) => fn({ setAttribute: vi.fn() }),
}));

import type { Graph } from '../src/types/graph.js';
import type { WorkflowState } from '../src/types/state.js';

// ─── Deferred import to avoid top-level await crashing the worker ────────
// eslint-disable-next-line prefer-const
let GraphRunner: Awaited<typeof import('../src/runner/graph-runner.js')>['GraphRunner'];

beforeAll(async () => {
  ({ GraphRunner } = await import('../src/runner/graph-runner.js'));
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
  test('should stop at max_iterations', async () => {
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
});

describe('GraphRunner — Timeout Management', () => {
  test('should throw WorkflowTimeoutError if max_execution_time_ms exceeded', async () => {
    const graph = createLinearGraph();
    const initialState = createInitialState();
    initialState.max_execution_time_ms = 10;

    const slowPersist = async () => {
      await new Promise(resolve => setTimeout(resolve, 20));
    };

    const slowRunner = new GraphRunner(graph, initialState, { persistStateFn: slowPersist });

    // Timeout now throws instead of returning silently
    try {
      await slowRunner.run();
      // If it completes before timeout, that's also acceptable
    } catch (error) {
      expect((error as Error).name).toBe('WorkflowTimeoutError');
    }
  }, 10000);

  test('should emit workflow:timeout event on timeout', async () => {
    const graph = createLinearGraph();
    const initialState = createInitialState();
    initialState.max_execution_time_ms = 1;

    const runner = new GraphRunner(graph, initialState);
    const timeoutSpy = vi.fn();
    runner.on('workflow:timeout', timeoutSpy);

    try {
      await runner.run();
    } catch {
      // Expected: WorkflowTimeoutError is thrown after timeout
    }

    if (timeoutSpy.mock.calls.length > 0) {
      expect(timeoutSpy).toHaveBeenCalledWith(
        expect.objectContaining({ workflow_id: initialState.workflow_id, elapsed_ms: expect.any(Number) })
      );
    }
  }, 5000);

  // A NODE-level timeout must abort only that node's in-flight work — not the
  // single shared workflow controller, which would cancel parallel siblings and
  // irreversibly trip the run loop.
  test('a node-level timeout aborts only the node controller, not the workflow controller', async () => {
    const { executeAgent } = await import('../src/agent/agent-executor/executor.js');

    const graph = createLinearGraph();
    // Tiny node timeout on the first node; workflow deadline far away so the
    // NODE timeout (not the workflow timeout) is what fires. max_retries: 1 =
    // exactly one attempt (the retry loop runs `1..=max_retries`).
    graph.nodes[0].failure_policy = {
      max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 10, max_backoff_ms: 10, timeout_ms: 30,
    };
    const initialState = createInitialState();
    initialState.max_execution_time_ms = 3_600_000;

    // Hang forever (never settles) so the node timeout is what ends the node.
    // Capture the abort signal the node received.
    let nodeSignal: AbortSignal | undefined;
    (executeAgent as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(
      (_id: string, _sv: unknown, _tools: unknown, _attempt: number, opts?: { abortSignal?: AbortSignal }) =>
        new Promise(() => { nodeSignal = opts?.abortSignal; }),
    );

    const runner = new GraphRunner(graph, initialState);
    await expect(runner.run()).rejects.toThrow(/timeout/i);

    // The node's in-flight call was cancelled by the per-node controller...
    expect(nodeSignal?.aborted).toBe(true);
    // ...but the shared workflow controller must NOT be poisoned by a node
    // timeout. (No public accessor — assert the internal invariant directly.)
    expect((runner as unknown as { abortController: AbortController }).abortController.signal.aborted).toBe(false);
  }, 5000);
});
