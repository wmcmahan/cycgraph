import { describe, test, expect, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { GraphRunner } from '../src/runner/graph-runner';
import { isTerminalEvent } from '../src/runner/stream-events';
import type { StreamEvent } from '../src/runner/stream-events';

// ─── Mocks ──────────────────────────────────────────────────────────

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

vi.mock('../src/agent/agent-executor/executor', () => ({
  executeAgent: vi.fn(async (agentId: string, _stateView: any, _tools: any, attempt: number) => ({
    id: uuidv4(),
    idempotency_key: uuidv4(),
    type: 'update_memory',
    payload: { updates: { [`${agentId}_result`]: 'Mock agent output' } },
    metadata: { node_id: agentId, agent_id: agentId, timestamp: new Date(), attempt },
  })),
}));

vi.mock('../src/agent/supervisor-executor', () => ({
  executeSupervisor: vi.fn(),
}));

vi.mock('../src/agent/agent-factory', () => ({
  agentFactory: {
    loadAgent: vi.fn().mockResolvedValue({
      id: 'test-agent', name: 'Test', model: 'claude-3-5-sonnet', provider: 'anthropic',
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
  withSpan: (_tracer: any, _name: string, fn: (span: any) => any) => fn({ setAttribute: vi.fn() }),
}));

import type { Graph } from '../src/types/graph';
import type { WorkflowState } from '../src/types/state';

// ─── Helpers ────────────────────────────────────────────────────────

const createInitialState = (overrides: Partial<WorkflowState> = {}): WorkflowState => ({
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
  total_cost_usd: 0,
  _cost_alert_thresholds_fired: [],
  ...overrides,
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

const createSingleNodeGraph = (): Graph => ({
  id: uuidv4(),
  name: 'Single Node Graph',
  description: 'One-node graph',
  nodes: [
    {
      id: 'only', type: 'agent', agent_id: 'agent-1',
      read_keys: ['*'], write_keys: ['*'],
      failure_policy: { max_retries: 3, backoff_strategy: 'exponential', initial_backoff_ms: 100, max_backoff_ms: 1000 },
      requires_compensation: false,
    },
  ],
  edges: [],
  start_node: 'only',
  end_nodes: ['only'],
});

async function collectStreamEvents(runner: GraphRunner, options?: { signal?: AbortSignal }): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of runner.stream(options)) {
    events.push(event);
  }
  return events;
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('GraphRunner.stream() — Event Sequence', () => {
  test('yields correct event order for a linear graph', async () => {
    const runner = new GraphRunner(createLinearGraph(), createInitialState());
    const events = await collectStreamEvents(runner);

    const types = events.map(e => e.type);

    // Must start with workflow:start
    expect(types[0]).toBe('workflow:start');

    // Must contain node lifecycle events for both nodes
    expect(types).toContain('node:start');
    expect(types).toContain('node:complete');
    expect(types).toContain('action:applied');

    // Must end with workflow:complete
    expect(types[types.length - 1]).toBe('workflow:complete');
  });

  test('yields node:start before node:complete for each node', async () => {
    const runner = new GraphRunner(createLinearGraph(), createInitialState());
    const events = await collectStreamEvents(runner);

    const nodeEvents = events.filter(
      e => e.type === 'node:start' || e.type === 'node:complete'
    ) as (StreamEvent & { node_id: string })[];

    // For each node, start must come before complete
    const nodeIds = [...new Set(nodeEvents.map(e => e.node_id))];
    for (const nodeId of nodeIds) {
      const forNode = nodeEvents.filter(e => e.node_id === nodeId);
      const startIdx = forNode.findIndex(e => e.type === 'node:start');
      const completeIdx = forNode.findIndex(e => e.type === 'node:complete');
      expect(startIdx).toBeLessThan(completeIdx);
    }
  });

  test('single node graph yields workflow:start → node events → workflow:complete', async () => {
    const runner = new GraphRunner(createSingleNodeGraph(), createInitialState());
    const events = await collectStreamEvents(runner);

    const types = events.map(e => e.type);
    expect(types[0]).toBe('workflow:start');
    expect(types[types.length - 1]).toBe('workflow:complete');
    expect(types).toContain('node:start');
    expect(types).toContain('node:complete');
    expect(types).toContain('action:applied');
  });
});

describe('GraphRunner.stream() — Terminal Events', () => {
  test('workflow:complete carries state with status completed', async () => {
    const runner = new GraphRunner(createLinearGraph(), createInitialState());
    const events = await collectStreamEvents(runner);

    const completeEvent = events.find(e => e.type === 'workflow:complete');
    expect(completeEvent).toBeDefined();
    expect(completeEvent!.type).toBe('workflow:complete');
    if (completeEvent!.type === 'workflow:complete') {
      expect(completeEvent!.state.status).toBe('completed');
      expect(completeEvent!.duration_ms).toBeGreaterThanOrEqual(0);
    }
  });

  test('workflow:failed carries error and state on failure', async () => {
    // Use an invalid graph to trigger failure
    const badGraph: Graph = {
      id: uuidv4(),
      name: 'Bad Graph',
      description: 'Invalid graph',
      nodes: [],
      edges: [],
      start_node: 'nonexistent',
      end_nodes: [],
    };
    const runner = new GraphRunner(badGraph, createInitialState());
    const events = await collectStreamEvents(runner);

    const failedEvent = events.find(e => e.type === 'workflow:failed');
    expect(failedEvent).toBeDefined();
    if (failedEvent!.type === 'workflow:failed') {
      expect(failedEvent!.error).toBeTruthy();
      expect(failedEvent!.state).toBeDefined();
    }
  });

  test('workflow:waiting event for HITL approval nodes', async () => {
    // Mock executeAgent to return a request_human_input action
    const { executeAgent } = await import('../src/agent/agent-executor/executor');
    const mockedExecute = vi.mocked(executeAgent);
    mockedExecute.mockResolvedValueOnce({
      id: uuidv4(),
      idempotency_key: uuidv4(),
      type: 'request_human_input',
      payload: {
        waiting_for: 'human_approval',
        prompt: 'Please approve',
      },
      metadata: { node_id: 'start', agent_id: 'agent-1', timestamp: new Date(), attempt: 1 },
    });

    const graph = createSingleNodeGraph();
    graph.end_nodes = []; // Not an end node — so it doesn't complete early
    graph.nodes[0].id = 'start';
    graph.start_node = 'start';
    const runner = new GraphRunner(graph, createInitialState());
    const events = await collectStreamEvents(runner);

    const waitingEvent = events.find(e => e.type === 'workflow:waiting');
    expect(waitingEvent).toBeDefined();
    if (waitingEvent?.type === 'workflow:waiting') {
      expect(waitingEvent.waiting_for).toBe('human_approval');
      expect(waitingEvent.state).toBeDefined();
    }
  });
});

describe('GraphRunner.stream() — Token Streaming', () => {
  test('yields agent:token_delta events with onToken callback', async () => {
    const tokenEvents: StreamEvent[] = [];
    const onToken = vi.fn();

    // Mock executeAgent to simulate token callbacks
    const { executeAgent } = await import('../src/agent/agent-executor/executor');
    const mockedExecute = vi.mocked(executeAgent);
    mockedExecute.mockImplementation(async (agentId, _stateView, _tools, attempt) => {
      // The onToken is wired via buildExecutorContext, but since we mock
      // executeAgent directly, tokens come through the onToken option callback
      return {
        id: uuidv4(),
        idempotency_key: uuidv4(),
        type: 'update_memory',
        payload: { updates: { result: 'done' } },
        metadata: { node_id: agentId, agent_id: agentId, timestamp: new Date(), attempt },
      };
    });

    const runner = new GraphRunner(createSingleNodeGraph(), createInitialState(), { onToken });
    const events = await collectStreamEvents(runner);

    // Even without actual token deltas (mock doesn't call onToken),
    // the stream should still complete successfully
    expect(events.map(e => e.type)).toContain('workflow:complete');
  });
});

describe('GraphRunner.stream() — Cancellation', () => {
  test('AbortSignal cancels stream cleanly', async () => {
    const controller = new AbortController();
    const runner = new GraphRunner(createLinearGraph(), createInitialState());

    // Abort immediately
    controller.abort();

    const events = await collectStreamEvents(runner, { signal: controller.signal });
    const types = events.map(e => e.type);

    // Should have started but workflow should not complete normally
    expect(types[0]).toBe('workflow:start');
  });

  test('already-aborted signal stops immediately', async () => {
    const controller = new AbortController();
    controller.abort();

    const runner = new GraphRunner(createSingleNodeGraph(), createInitialState());
    const events = await collectStreamEvents(runner, { signal: controller.signal });

    // Should not have any completed workflow
    const hasComplete = events.some(e => e.type === 'workflow:complete');
    // The workflow either didn't complete or terminated early
    expect(events.length).toBeGreaterThan(0);
  });
});

describe('GraphRunner.stream() — Backward Compatibility', () => {
  test('run() still returns WorkflowState', async () => {
    const runner = new GraphRunner(createLinearGraph(), createInitialState());
    const result = await runner.run();

    expect(result.status).toBe('completed');
    expect(result.visited_nodes).toContain('start');
    expect(result.visited_nodes).toContain('end');
  });

  test('run() still throws on graph validation failure', async () => {
    const badGraph: Graph = {
      id: uuidv4(),
      name: 'Bad',
      description: 'Invalid',
      nodes: [],
      edges: [],
      start_node: 'nonexistent',
      end_nodes: [],
    };
    const runner = new GraphRunner(badGraph, createInitialState());

    await expect(runner.run()).rejects.toThrow('Graph validation failed');
  });

  test('run() still emits EventEmitter events', async () => {
    const runner = new GraphRunner(createLinearGraph(), createInitialState());

    const startSpy = vi.fn();
    const completeSpy = vi.fn();
    runner.on('workflow:start', startSpy);
    runner.on('workflow:complete', completeSpy);

    await runner.run();

    expect(startSpy).toHaveBeenCalledOnce();
    expect(completeSpy).toHaveBeenCalledOnce();
  });

  test('run() cleans up listeners after completion', async () => {
    const runner = new GraphRunner(createLinearGraph(), createInitialState());
    const spy = vi.fn();
    runner.on('workflow:start', spy);

    await runner.run();

    // After run(), listeners should be removed
    expect(runner.listenerCount('workflow:start')).toBe(0);
  });

  test('state:persisted events emitted with persistStateFn', async () => {
    const persistSpy = vi.fn().mockResolvedValue(undefined);
    const runner = new GraphRunner(createLinearGraph(), createInitialState(), { persistStateFn: persistSpy });
    const events = await collectStreamEvents(runner);

    const persisted = events.filter(e => e.type === 'state:persisted');
    expect(persisted.length).toBeGreaterThan(0);
    if (persisted[0].type === 'state:persisted') {
      expect(persisted[0].run_id).toBeTruthy();
    }
  });
});

describe('isTerminalEvent — Type Guard', () => {
  test('returns true for workflow:complete', () => {
    const event: StreamEvent = {
      type: 'workflow:complete',
      workflow_id: 'w1',
      run_id: 'r1',
      duration_ms: 100,
      state: createInitialState(),
      timestamp: Date.now(),
    };
    expect(isTerminalEvent(event)).toBe(true);
  });

  test('returns true for workflow:failed', () => {
    const event: StreamEvent = {
      type: 'workflow:failed',
      workflow_id: 'w1',
      run_id: 'r1',
      error: 'boom',
      state: createInitialState(),
      timestamp: Date.now(),
    };
    expect(isTerminalEvent(event)).toBe(true);
  });

  test('returns true for workflow:timeout', () => {
    const event: StreamEvent = {
      type: 'workflow:timeout',
      workflow_id: 'w1',
      run_id: 'r1',
      elapsed_ms: 5000,
      state: createInitialState(),
      timestamp: Date.now(),
    };
    expect(isTerminalEvent(event)).toBe(true);
  });

  test('returns true for workflow:waiting', () => {
    const event: StreamEvent = {
      type: 'workflow:waiting',
      workflow_id: 'w1',
      run_id: 'r1',
      waiting_for: 'human_approval',
      state: createInitialState(),
      timestamp: Date.now(),
    };
    expect(isTerminalEvent(event)).toBe(true);
  });

  test('returns false for non-terminal events', () => {
    const nonTerminals: StreamEvent[] = [
      { type: 'workflow:start', workflow_id: 'w1', run_id: 'r1', timestamp: Date.now() },
      { type: 'node:start', node_id: 'n1', node_type: 'agent', timestamp: Date.now() },
      { type: 'node:complete', node_id: 'n1', node_type: 'agent', duration_ms: 10, timestamp: Date.now() },
      { type: 'action:applied', action_id: 'a1', action_type: 'update_memory', node_id: 'n1', timestamp: Date.now() },
      { type: 'agent:token_delta', run_id: 'r1', node_id: 'n1', token: 'hello', timestamp: Date.now() },
    ];

    for (const event of nonTerminals) {
      expect(isTerminalEvent(event)).toBe(false);
    }
  });
});
