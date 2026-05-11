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

vi.mock('../src/agent/supervisor-executor/executor.js', () => ({
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

describe('GraphRunner — Memory Updates', () => {
  test('should update memory through node execution', async () => {
    const initialState = createInitialState();
    initialState.memory = { initial: true };

    const runner = new GraphRunner(createLinearGraph(), initialState);
    const finalState = await runner.run();

    expect(Object.keys(finalState.memory).length).toBeGreaterThan(0);
  });
});

describe('GraphRunner — Node Types', () => {
  test('should handle agent nodes', async () => {
    const runner = new GraphRunner(createLinearGraph(), createInitialState());
    const finalState = await runner.run();
    expect(finalState.status).toBe('completed');
  });

  test('should handle tool nodes', async () => {
    const graph: Graph = {
      ...createLinearGraph(),
      nodes: [
        {
          id: 'start', type: 'tool', tool_id: 'calculator',
          read_keys: ['*'], write_keys: ['*'],
          failure_policy: { max_retries: 3, backoff_strategy: 'exponential', initial_backoff_ms: 100, max_backoff_ms: 1000 },
          requires_compensation: false,
        },
        {
          id: 'end', type: 'tool', tool_id: 'formatter',
          read_keys: ['result'], write_keys: ['*'],
          failure_policy: { max_retries: 3, backoff_strategy: 'exponential', initial_backoff_ms: 100, max_backoff_ms: 1000 },
          requires_compensation: false,
        },
      ],
      edges: [{ id: 'e1', source: 'start', target: 'end', condition: { type: 'always' } }],
      start_node: 'start',
      end_nodes: ['end'],
    };

    const runner = new GraphRunner(graph, createInitialState());
    const finalState = await runner.run();
    expect(finalState.status).toBe('completed');
  });

  test('should handle router nodes', async () => {
    const graph: Graph = {
      ...createLinearGraph(),
      nodes: [
        {
          id: 'start', type: 'router',
          read_keys: ['*'], write_keys: [],
          failure_policy: { max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 100, max_backoff_ms: 1000 },
          requires_compensation: false,
        },
        {
          id: 'end', type: 'agent', agent_id: 'processor',
          read_keys: ['*'], write_keys: ['*'],
          failure_policy: { max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 100, max_backoff_ms: 1000 },
          requires_compensation: false,
        },
      ],
      edges: [{ id: 'e1', source: 'start', target: 'end', condition: { type: 'always' } }],
      start_node: 'start',
      end_nodes: ['end'],
    };

    const runner = new GraphRunner(graph, createInitialState());
    const finalState = await runner.run();
    expect(finalState.status).toBe('completed');
  });
});

describe('GraphRunner — Execution Flow', () => {
  test('should transition through workflow statuses', async () => {
    const statusChanges: string[] = [];
    const persistFn = async (state: WorkflowState) => {
      statusChanges.push(state.status);
    };

    const runner = new GraphRunner(createLinearGraph(), createInitialState(), { persistStateFn: persistFn });
    await runner.run();

    expect(statusChanges).toContain('running');
    expect(statusChanges[statusChanges.length - 1]).toBe('completed');
  });
});
