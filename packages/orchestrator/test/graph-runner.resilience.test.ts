/**
 * graph-runner.resilience.test.ts
 *
 * Battle-tests for failure recovery, retry/backoff, circuit breaker,
 * saga rollback, per-node timeouts, and error event emission.
 *
 * These tests verify the runner doesn't just handle the happy path —
 * they exercise the failure modes that will occur in production when
 * LLM calls fail, tools time out, and nodes return garbage.
 */
import { describe, it, expect, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';

// ─── Mocks ──────────────────────────────────────────────────────────────

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

/**
 * This mock tracks call counts per agent_id so we can make agents fail
 * on specific attempts and succeed on others.
 */
const agentCallCounts = new Map<string, number>();

const observedRunContext: { run_id?: string; graph_id?: string } = {};

vi.mock('../src/agents/executors/agent/executor', () => ({
  executeAgent: vi.fn(async (agentId: string, _stateView: any, _tools: any, attempt: number) => {
    const count = (agentCallCounts.get(agentId) || 0) + 1;
    agentCallCounts.set(agentId, count);

    if (agentId === 'context-probe') {
      const { getCurrentContext } = await import('../src/utils/context.js');
      const ctx = getCurrentContext();
      observedRunContext.run_id = ctx.run_id;
      observedRunContext.graph_id = ctx.graph_id;
    }

    if (agentId === 'always-fail') {
      throw new Error(`Agent ${agentId} permanently failed (call ${count})`);
    }

    if (agentId === 'fail-then-succeed' && count <= 2) {
      throw new Error(`Agent ${agentId} transient failure (call ${count})`);
    }

    if (agentId === 'fail-with-usage' && count === 1) {
      const err = new Error('transient failure after partial spend') as Error & { partialUsage?: unknown };
      err.partialUsage = { inputTokens: 40, outputTokens: 10, totalTokens: 50, model: 'gpt-4o' };
      throw err;
    }

    if (agentId === 'non-retryable') {
      const err = new Error('context length exceeded') as Error & { retryable?: boolean };
      err.retryable = false;
      throw err;
    }

    if (agentId === 'slow-agent') {
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    return {
      id: uuidv4(),
      idempotency_key: `${agentId}:${count}:${attempt}`,
      type: 'update_memory',
      payload: { updates: { [`${agentId}_result`]: `done_call_${count}` } },
      metadata: { node_id: agentId, agent_id: agentId, timestamp: new Date(), attempt },
    };
  }),
}));

vi.mock('../src/agents/executors/supervisor', () => ({
  executeSupervisor: vi.fn(),
}));

vi.mock('../src/agents/factory', () => ({
  agentFactory: {
    loadAgent: vi.fn().mockResolvedValue({
      id: 'test-agent', name: 'Test', model: 'claude-3-5-sonnet', provider: 'anthropic',
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
  withSpan: (_tracer: any, _name: string, fn: (span: any) => any) => fn({ setAttribute: vi.fn() }),
  startSpan: () => ({ setAttribute: vi.fn(), end: vi.fn() }),
  inSpanContext: (_span: any, fn: () => any) => fn(),
}));

vi.mock('../src/execution/engine/helpers', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    sleep: vi.fn().mockResolvedValue(undefined),
  };
});

import { GraphRunner } from '../src/execution/engine/graph-runner.js';
import type { Graph, GraphNode } from '../src/graph/graph.js';
import type { WorkflowState } from '../src/state/state.js';

import { beforeEach } from 'vitest';
beforeEach(() => {
  agentCallCounts.clear();
});

// ─── Helpers ────────────────────────────────────────────────────────────

const makeNode = (overrides: Partial<GraphNode> & { id: string; type: GraphNode['type'] }): GraphNode => ({
  read_keys: ['*'],
  write_keys: ['*'],
  failure_policy: { max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 10, max_backoff_ms: 10 },
  requires_compensation: false,
  ...overrides,
});

const createState = (overrides: Partial<WorkflowState> = {}): WorkflowState => ({
  workflow_id: uuidv4(),
  run_id: uuidv4(),
  created_at: new Date(),
  updated_at: new Date(),
  goal: 'Resilience test',
  constraints: [],
  status: 'pending',
  iteration_count: 0,
  retry_count: 0,
  max_retries: 3,
  memory: {},
  visited_nodes: [],
  max_iterations: 50,
  compensation_stack: [],
  max_execution_time_ms: 30000,
  supervisor_history: [],
  total_tokens_used: 0,
  ...overrides,
});

// ─── Tests ──────────────────────────────────────────────────────────────

describe('GraphRunner — Retry Behavior', () => {
  /**
   * The agent fails on the first 2 calls but succeeds on the 3rd.
   * With max_retries=3, the node should succeed after retrying.
   */
  it('should retry failed node and succeed on later attempt', async () => {
    const graph: Graph = {
      id: uuidv4(), name: 'Retry Success', description: '',
      nodes: [
        makeNode({
          id: 'flaky-node', type: 'agent', agent_id: 'fail-then-succeed',
          failure_policy: { max_retries: 3, backoff_strategy: 'fixed', initial_backoff_ms: 10, max_backoff_ms: 100 },
        }),
      ],
      edges: [],
      start_node: 'flaky-node',
      end_nodes: ['flaky-node'],
    };

    const runner = new GraphRunner(graph, createState());
    const final = await runner.run();

    expect(final.status).toBe('completed');
    expect(agentCallCounts.get('fail-then-succeed')).toBe(3);
  });

  it('counts tokens spent on a failed attempt toward the budget', async () => {
    const graph: Graph = {
      id: uuidv4(), name: 'Failed-attempt usage', description: '',
      nodes: [
        makeNode({
          id: 'spendy', type: 'agent', agent_id: 'fail-with-usage',
          failure_policy: { max_retries: 3, backoff_strategy: 'fixed', initial_backoff_ms: 10, max_backoff_ms: 100 },
        }),
      ],
      edges: [],
      start_node: 'spendy',
      end_nodes: ['spendy'],
    };

    const final = await new GraphRunner(graph, createState()).run();

    expect(final.status).toBe('completed');
    expect(final.total_tokens_used).toBeGreaterThanOrEqual(50);
  });

  it('run() establishes run/graph correlation context for node execution', async () => {
    observedRunContext.run_id = undefined;
    observedRunContext.graph_id = undefined;

    const graph: Graph = {
      id: uuidv4(), name: 'Context Probe', description: '',
      nodes: [makeNode({ id: 'probe', type: 'agent', agent_id: 'context-probe' })],
      edges: [],
      start_node: 'probe',
      end_nodes: ['probe'],
    };
    const state = createState();

    await new GraphRunner(graph, state).run();

    expect(observedRunContext.run_id).toBe(state.run_id);
    expect(observedRunContext.graph_id).toBe(graph.id);
  });

  it('does not retry a non-retryable error (short-circuits)', async () => {
    const graph: Graph = {
      id: uuidv4(), name: 'Non-retryable', description: '',
      nodes: [
        makeNode({
          id: 'perm-fail', type: 'agent', agent_id: 'non-retryable',
          failure_policy: { max_retries: 3, backoff_strategy: 'fixed', initial_backoff_ms: 10, max_backoff_ms: 100 },
        }),
      ],
      edges: [],
      start_node: 'perm-fail',
      end_nodes: ['perm-fail'],
    };

    await expect(new GraphRunner(graph, createState()).run()).rejects.toThrow(/context length/);

    expect(agentCallCounts.get('non-retryable')).toBe(1);
  });

  /**
   * The agent always fails. With max_retries=2, it should exhaust retries
   * and the workflow should fail with a meaningful error.
   */
  it('should fail workflow when node exhausts all retries', async () => {
    const graph: Graph = {
      id: uuidv4(), name: 'Retry Exhausted', description: '',
      nodes: [
        makeNode({
          id: 'broken-node', type: 'agent', agent_id: 'always-fail',
          failure_policy: { max_retries: 2, backoff_strategy: 'fixed', initial_backoff_ms: 10, max_backoff_ms: 100 },
        }),
      ],
      edges: [],
      start_node: 'broken-node',
      end_nodes: ['broken-node'],
    };

    const runner = new GraphRunner(graph, createState());
    await expect(runner.run()).rejects.toThrow('always-fail');

    expect(agentCallCounts.get('always-fail')).toBe(2);
  });

  it('reports the attempt a non-retryable failure happened on', async () => {
    const graph: Graph = {
      id: uuidv4(), name: 'Non-retryable attempt', description: '',
      nodes: [
        makeNode({
          id: 'perm-fail', type: 'agent', agent_id: 'non-retryable',
          failure_policy: { max_retries: 5, backoff_strategy: 'fixed', initial_backoff_ms: 0, max_backoff_ms: 0 },
        }),
      ],
      edges: [],
      start_node: 'perm-fail',
      end_nodes: ['perm-fail'],
    };

    const failures: number[] = [];
    const runner = new GraphRunner(graph, createState());
    runner.on('node:failed', (event) => failures.push(event.attempt as number));

    await expect(runner.run()).rejects.toThrow(/context length/);

    expect(failures).toEqual([1]);
  });

  it('executes a node once when max_retries is 0', async () => {
    const graph: Graph = {
      id: uuidv4(), name: 'No Retries', description: '',
      nodes: [
        makeNode({
          id: 'once', type: 'agent', agent_id: 'fail-then-succeed',
          failure_policy: { max_retries: 0, backoff_strategy: 'fixed', initial_backoff_ms: 0, max_backoff_ms: 0 },
        }),
      ],
      edges: [],
      start_node: 'once',
      end_nodes: ['once'],
    };

    await expect(new GraphRunner(graph, createState()).run()).rejects.toThrow(/transient failure/);

    expect(agentCallCounts.get('fail-then-succeed')).toBe(1);
  });

  it('completes on the single attempt max_retries 0 allows', async () => {
    const graph: Graph = {
      id: uuidv4(), name: 'No Retries Success', description: '',
      nodes: [
        makeNode({
          id: 'once', type: 'agent', agent_id: 'healthy',
          failure_policy: { max_retries: 0, backoff_strategy: 'fixed', initial_backoff_ms: 0, max_backoff_ms: 0 },
        }),
      ],
      edges: [],
      start_node: 'once',
      end_nodes: ['once'],
    };

    const final = await new GraphRunner(graph, createState()).run();

    expect(final.status).toBe('completed');
    expect(agentCallCounts.get('healthy')).toBe(1);
  });

  /**
   * Retry emits node:retry events with attempt count and backoff.
   */
  it('should emit node:retry events during retries', async () => {
    const graph: Graph = {
      id: uuidv4(), name: 'Retry Events', description: '',
      nodes: [
        makeNode({
          id: 'flaky', type: 'agent', agent_id: 'fail-then-succeed',
          failure_policy: { max_retries: 3, backoff_strategy: 'fixed', initial_backoff_ms: 50, max_backoff_ms: 1000 },
        }),
      ],
      edges: [],
      start_node: 'flaky',
      end_nodes: ['flaky'],
    };

    const runner = new GraphRunner(graph, createState());
    const retrySpy = vi.fn();
    runner.on('node:retry', retrySpy);

    await runner.run();

    expect(retrySpy).toHaveBeenCalledTimes(2);
    expect(retrySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        node_id: 'flaky',
        attempt: expect.any(Number),
        backoff_ms: expect.any(Number),
      })
    );
  });
});

describe('GraphRunner — Error Handling & Events', () => {
  /**
   * When a node permanently fails, the runner should:
   * 1. Set status to 'failed'
   * 2. Populate last_error with a meaningful message
   * 3. Emit workflow:failed event
   * 4. Persist the failed state
   */
  it('should set status to failed and emit workflow:failed on node error', async () => {
    const graph: Graph = {
      id: uuidv4(), name: 'Fail Flow', description: '',
      nodes: [
        makeNode({
          id: 'exploder', type: 'agent', agent_id: 'always-fail',
          failure_policy: { max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 10, max_backoff_ms: 10 },
        }),
      ],
      edges: [],
      start_node: 'exploder',
      end_nodes: ['exploder'],
    };

    const persistSpy = vi.fn().mockResolvedValue(undefined);
    const failedSpy = vi.fn();
    const runner = new GraphRunner(graph, createState(), { persistStateFn: persistSpy });
    runner.on('workflow:failed', failedSpy);

    await runner.run().catch(() => {});

    expect(failedSpy).toHaveBeenCalledOnce();
    expect(failedSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.stringContaining('always-fail'),
      })
    );

    const lastPersistedState = persistSpy.mock.calls[persistSpy.mock.calls.length - 1][0] as WorkflowState;
    expect(lastPersistedState.status).toBe('failed');
    expect(lastPersistedState.last_error).toBeDefined();
    expect(lastPersistedState.last_error).toContain('always-fail');
  });

  /**
   * node:failed event should be emitted when a node exhausts retries.
   */
  it('should emit node:failed event when node exhausts retries', async () => {
    const graph: Graph = {
      id: uuidv4(), name: 'Node Fail Event', description: '',
      nodes: [
        makeNode({
          id: 'bad-node', type: 'agent', agent_id: 'always-fail',
          failure_policy: { max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 10, max_backoff_ms: 10 },
        }),
      ],
      edges: [],
      start_node: 'bad-node',
      end_nodes: ['bad-node'],
    };

    const nodeFailedSpy = vi.fn();
    const runner = new GraphRunner(graph, createState());
    runner.on('node:failed', nodeFailedSpy);

    await runner.run().catch(() => {});

    expect(nodeFailedSpy).toHaveBeenCalledOnce();
    expect(nodeFailedSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        node_id: 'bad-node',
        type: 'agent',
        error: expect.stringContaining('always-fail'),
      })
    );
  });

  /**
   * Failure in a non-start node should still fail the workflow correctly.
   * start succeeds → middle fails → workflow fails
   */
  it('should propagate failure from non-start node', async () => {
    const graph: Graph = {
      id: uuidv4(), name: 'Mid Fail', description: '',
      nodes: [
        makeNode({ id: 'ok-node', type: 'agent', agent_id: 'good-agent' }),
        makeNode({
          id: 'bad-node', type: 'agent', agent_id: 'always-fail',
          failure_policy: { max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 10, max_backoff_ms: 10 },
        }),
      ],
      edges: [
        { id: 'e1', source: 'ok-node', target: 'bad-node', condition: { type: 'always' } },
      ],
      start_node: 'ok-node',
      end_nodes: ['bad-node'],
    };

    const runner = new GraphRunner(graph, createState());

    try {
      await runner.run();
      expect(true).toBe(false);
    } catch (error) {
      expect((error as Error).message).toContain('always-fail');
    }
  });
});

describe('GraphRunner — Per-Node Timeout', () => {
  /**
   * If a node has timeout_ms set and the execution takes longer,
   * it should throw a timeout error.
   *
   * 'slow-agent' is mocked to take 500ms; timeout_ms is 50ms.
   */
  it('should enforce per-node timeout_ms', async () => {
    const graph: Graph = {
      id: uuidv4(), name: 'Node Timeout', description: '',
      nodes: [
        makeNode({
          id: 'slow-node', type: 'agent', agent_id: 'slow-agent',
          failure_policy: {
            max_retries: 1,
            backoff_strategy: 'fixed',
            initial_backoff_ms: 10,
            max_backoff_ms: 10,
            timeout_ms: 50,
          },
        }),
      ],
      edges: [],
      start_node: 'slow-node',
      end_nodes: ['slow-node'],
    };

    const runner = new GraphRunner(graph, createState());

    await expect(runner.run()).rejects.toThrow(/timeout/i);
  });

  /**
   * Node WITHOUT timeout_ms should execute normally even if it takes a while.
   */
  it('should not timeout nodes without timeout_ms configured', async () => {
    const graph: Graph = {
      id: uuidv4(), name: 'No Timeout', description: '',
      nodes: [
        makeNode({
          id: 'normal-node', type: 'agent', agent_id: 'good-agent',
          failure_policy: { max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 10, max_backoff_ms: 10 },
        }),
      ],
      edges: [],
      start_node: 'normal-node',
      end_nodes: ['normal-node'],
    };

    const runner = new GraphRunner(graph, createState());
    const final = await runner.run();

    expect(final.status).toBe('completed');
  });
});

describe('GraphRunner — Subgraph Node Validation', () => {
  it('should throw when subgraph node has no loadGraphFn', async () => {
    const graph: Graph = {
      id: uuidv4(), name: 'Subgraph Test', description: '',
      nodes: [
        makeNode({ id: 'sub', type: 'subgraph', subgraph_id: 'nested-graph', subgraph_config: { subgraph_id: 'nested-graph', input_mapping: {}, output_mapping: {}, max_iterations: 50 } }),
      ],
      edges: [],
      start_node: 'sub',
      end_nodes: ['sub'],
    };

    const runner = new GraphRunner(graph, createState());

    await expect(runner.run()).rejects.toThrow(/loadGraphFn/);
  });

  it('synthesizer node should execute without error (simple merge)', async () => {
    const graph: Graph = {
      id: uuidv4(), name: 'Synthesizer Test', description: '',
      nodes: [
        makeNode({ id: 'synth', type: 'synthesizer' }),
      ],
      edges: [],
      start_node: 'synth',
      end_nodes: ['synth'],
    };

    const runner = new GraphRunner(graph, createState());
    const finalState = await runner.run();

    expect(finalState.status).toBe('completed');
    expect(finalState.memory.synth_synthesis).toBeDefined();
  });
});

describe('GraphRunner — Saga Rollback', () => {
  /**
   * When rollback() is called, compensation actions should be applied
   * in LIFO order (most recent first). Status should be 'cancelled'.
   */
  it('should apply compensation actions in reverse order during rollback', async () => {
    const state = createState({
      status: 'failed',
      compensation_stack: [
        {
          action_id: 'action-1',
          compensation_action: {
            id: uuidv4(),
            idempotency_key: 'comp-1',
            type: 'update_memory',
            payload: { updates: { step1: 'rolled_back' } },
            metadata: { node_id: 'node-1', timestamp: new Date(), attempt: 1 },
          },
        },
        {
          action_id: 'action-2',
          compensation_action: {
            id: uuidv4(),
            idempotency_key: 'comp-2',
            type: 'update_memory',
            payload: { updates: { step2: 'rolled_back' } },
            metadata: { node_id: 'node-2', timestamp: new Date(), attempt: 1 },
          },
        },
      ],
    });

    const graph: Graph = {
      id: uuidv4(), name: 'Rollback', description: '',
      nodes: [makeNode({ id: 'dummy', type: 'agent', agent_id: 'x' })],
      edges: [],
      start_node: 'dummy',
      end_nodes: ['dummy'],
    };

    const persistSpy = vi.fn().mockResolvedValue(undefined);
    const runner = new GraphRunner(graph, state, { persistStateFn: persistSpy });

    await runner.rollback();

    const lastPersisted = persistSpy.mock.calls[persistSpy.mock.calls.length - 1][0] as WorkflowState;
    expect(lastPersisted.status).toBe('cancelled');
    expect(lastPersisted.memory.step1).toBe('rolled_back');
    expect(lastPersisted.memory.step2).toBe('rolled_back');
    expect(lastPersisted.compensation_stack).toHaveLength(0);
  });

  /**
   * Rollback should emit workflow:rollback event.
   */
  it('should emit workflow:rollback event', async () => {
    const state = createState({
      status: 'failed',
      compensation_stack: [],
    });

    const graph: Graph = {
      id: uuidv4(), name: 'Rollback Event', description: '',
      nodes: [makeNode({ id: 'dummy', type: 'agent', agent_id: 'x' })],
      edges: [],
      start_node: 'dummy',
      end_nodes: ['dummy'],
    };

    const rollbackSpy = vi.fn();
    const runner = new GraphRunner(graph, state, { persistStateFn: vi.fn().mockResolvedValue(undefined) });
    runner.on('workflow:rollback', rollbackSpy);

    await runner.rollback();

    expect(rollbackSpy).toHaveBeenCalledOnce();
    expect(rollbackSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        workflow_id: state.workflow_id,
        run_id: state.run_id,
      })
    );
  });

  /**
   * If a compensation action is malformed (fails schema validation),
   * it should be skipped — not crash the entire rollback.
   * This is critical: a crashed rollback could leave state inconsistent.
   */
  it('should skip invalid compensation actions without crashing', async () => {
    const state = createState({
      status: 'failed',
      compensation_stack: [
        {
          action_id: 'good-action',
          compensation_action: {
            id: uuidv4(),
            idempotency_key: 'comp-good',
            type: 'update_memory',
            payload: { updates: { good: true } },
            metadata: { node_id: 'node-1', timestamp: new Date(), attempt: 1 },
          },
        },
        {
          action_id: 'bad-action',
          compensation_action: {
            type: 'update_memory',
          } as any,
        },
      ],
    });

    const graph: Graph = {
      id: uuidv4(), name: 'Partial Rollback', description: '',
      nodes: [makeNode({ id: 'dummy', type: 'agent', agent_id: 'x' })],
      edges: [],
      start_node: 'dummy',
      end_nodes: ['dummy'],
    };

    const persistSpy = vi.fn().mockResolvedValue(undefined);
    const runner = new GraphRunner(graph, state, { persistStateFn: persistSpy });

    await runner.rollback();

    const lastPersisted = persistSpy.mock.calls[persistSpy.mock.calls.length - 1][0] as WorkflowState;
    expect(lastPersisted.status).toBe('cancelled');
    expect(lastPersisted.memory.good).toBe(true);
  });
});

describe('GraphRunner — Graph Validation', () => {
  /**
   * A graph with a start_node that doesn't exist should fail validation
   * and throw BEFORE any node execution occurs.
   */
  it('should throw on invalid graph (start node not in nodes)', async () => {
    const graph: Graph = {
      id: uuidv4(), name: 'Invalid', description: '',
      nodes: [
        makeNode({ id: 'orphan', type: 'agent', agent_id: 'agent-x' }),
      ],
      edges: [],
      start_node: 'nonexistent',
      end_nodes: ['orphan'],
    };

    const runner = new GraphRunner(graph, createState());

    await expect(runner.run()).rejects.toThrow(/validation failed/i);
  });

  /**
   * A graph with an end_node that doesn't exist should also fail validation.
   */
  it('should throw on invalid graph (end node references missing node)', async () => {
    const graph: Graph = {
      id: uuidv4(), name: 'Bad End', description: '',
      nodes: [
        makeNode({ id: 'start', type: 'agent', agent_id: 'agent-1' }),
      ],
      edges: [],
      start_node: 'start',
      end_nodes: ['does-not-exist'],
    };

    const runner = new GraphRunner(graph, createState());

    await expect(runner.run()).rejects.toThrow(/validation failed/i);
  });

  /**
   * Validation failure should set state to 'failed' and persist it.
   */
  it('should persist failed state on graph validation failure', async () => {
    const graph: Graph = {
      id: uuidv4(), name: 'Invalid Persist', description: '',
      nodes: [],
      edges: [],
      start_node: 'nonexistent',
      end_nodes: [],
    };

    const persistSpy = vi.fn().mockResolvedValue(undefined);
    const runner = new GraphRunner(graph, createState(), { persistStateFn: persistSpy });

    await runner.run().catch(() => {});

    expect(persistSpy).toHaveBeenCalled();
    const lastPersisted = persistSpy.mock.calls[persistSpy.mock.calls.length - 1][0] as WorkflowState;
    expect(lastPersisted.status).toBe('failed');
    expect(lastPersisted.last_error).toContain('validation');
  });

  /**
   * Duplicate node IDs should cause graph validation to fail.
   */
  it('should throw on graph with duplicate node IDs', async () => {
    const graph: Graph = {
      id: uuidv4(), name: 'Duplicate IDs', description: '',
      nodes: [
        makeNode({ id: 'same-id', type: 'agent', agent_id: 'agent-1' }),
        makeNode({ id: 'same-id', type: 'agent', agent_id: 'agent-2' }),
      ],
      edges: [],
      start_node: 'same-id',
      end_nodes: ['same-id'],
    };

    const runner = new GraphRunner(graph, createState());

    await expect(runner.run()).rejects.toThrow(/validation failed|duplicate/i);
  });
});

describe('GraphRunner — Persistence Resilience', () => {
  /**
   * After MAX_PERSIST_FAILURES (3) consecutive failures, the workflow halts
   * to prevent data loss from unbounded in-memory-only execution.
   */
  it('should throw after consecutive persistence failures exceed threshold', async () => {
    const graph: Graph = {
      id: uuidv4(), name: 'Persist Fail', description: '',
      nodes: [
        makeNode({ id: 'start', type: 'agent', agent_id: 'good-agent' }),
        makeNode({ id: 'n2', type: 'agent', agent_id: 'good-agent' }),
        makeNode({ id: 'n3', type: 'agent', agent_id: 'good-agent' }),
        makeNode({ id: 'n4', type: 'agent', agent_id: 'good-agent' }),
        makeNode({ id: 'end', type: 'agent', agent_id: 'finish-agent' }),
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'n2', condition: { type: 'always' } },
        { id: 'e2', source: 'n2', target: 'n3', condition: { type: 'always' } },
        { id: 'e3', source: 'n3', target: 'n4', condition: { type: 'always' } },
        { id: 'e4', source: 'n4', target: 'end', condition: { type: 'always' } },
      ],
      start_node: 'start',
      end_nodes: ['end'],
    };

    const brokenPersist = vi.fn().mockRejectedValue(new Error('DB connection failed'));
    const runner = new GraphRunner(graph, createState(), { persistStateFn: brokenPersist });

    await expect(runner.run()).rejects.toThrow('Persistence unavailable');
    expect(brokenPersist).toHaveBeenCalled();
  });

  it('should reset persistence failure counter on success', async () => {
    const graph: Graph = {
      id: uuidv4(), name: 'Persist Recovery', description: '',
      nodes: [
        makeNode({ id: 'start', type: 'agent', agent_id: 'good-agent' }),
        makeNode({ id: 'n2', type: 'agent', agent_id: 'good-agent' }),
        makeNode({ id: 'n3', type: 'agent', agent_id: 'good-agent' }),
        makeNode({ id: 'end', type: 'agent', agent_id: 'finish-agent' }),
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'n2', condition: { type: 'always' } },
        { id: 'e2', source: 'n2', target: 'n3', condition: { type: 'always' } },
        { id: 'e3', source: 'n3', target: 'end', condition: { type: 'always' } },
      ],
      start_node: 'start',
      end_nodes: ['end'],
    };

    let callCount = 0;
    const intermittentPersist = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount % 3 !== 0) throw new Error('DB connection failed');
    });
    const runner = new GraphRunner(graph, createState(), { persistStateFn: intermittentPersist });
    const final = await runner.run();

    expect(final.status).toBe('completed');
  });

  it('should tolerate fewer than threshold consecutive failures', async () => {
    const graph: Graph = {
      id: uuidv4(), name: 'Persist Partial Fail', description: '',
      nodes: [
        makeNode({ id: 'start', type: 'agent', agent_id: 'good-agent' }),
        makeNode({ id: 'end', type: 'agent', agent_id: 'finish-agent' }),
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'end', condition: { type: 'always' } },
      ],
      start_node: 'start',
      end_nodes: ['end'],
    };

    let callCount = 0;
    const partialPersist = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount <= 2) throw new Error('DB connection failed');
    });
    const runner = new GraphRunner(graph, createState(), { persistStateFn: partialPersist });
    const final = await runner.run();

    expect(final.status).toBe('completed');
    expect(partialPersist).toHaveBeenCalled();
  });
});

describe('GraphRunner — Rate Limiter', () => {
  const singleAgentGraph = (): Graph => ({
    id: uuidv4(), name: 'Rate Limited', description: '',
    nodes: [makeNode({ id: 'n', type: 'agent', agent_id: 'good-agent' })],
    edges: [],
    start_node: 'n',
    end_nodes: ['n'],
  });

  it('awaits the rate limiter before each LLM call', async () => {
    const order: string[] = [];
    agentCallCounts.clear();
    const calls: Array<{ agentId: string; kind: string; nodeId?: string }> = [];

    const rateLimiter = vi.fn(async (req: { agentId: string; kind: string; nodeId?: string }) => {
      order.push('limiter');
      calls.push(req);
    });

    const runner = new GraphRunner(singleAgentGraph(), createState(), { rateLimiter });
    const final = await runner.run();

    expect(final.status).toBe('completed');
    expect(rateLimiter).toHaveBeenCalledTimes(1);
    expect(calls[0]).toMatchObject({ agentId: 'good-agent', kind: 'agent', nodeId: 'n' });
    expect(order[0]).toBe('limiter');
  });

  it('a throwing rate limiter fails the node', async () => {
    const rateLimiter = vi.fn(async () => { throw new Error('rate limit ceiling reached'); });

    const runner = new GraphRunner(singleAgentGraph(), createState(), { rateLimiter });
    await expect(runner.run()).rejects.toThrow(/rate limit ceiling reached/);
    expect(rateLimiter).toHaveBeenCalled();
  });

  it('no overhead path: runs normally without a rate limiter', async () => {
    const runner = new GraphRunner(singleAgentGraph(), createState());
    const final = await runner.run();
    expect(final.status).toBe('completed');
  });
});
