/**
 * graph-runner.rollback.test.ts
 *
 * Tests for auto_rollback option (task 1.5), approval gate timeout
 * enforcement (task 1.6), and graceful shutdown (task 4.4).
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
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
 * Track call counts per agent_id so we can make specific agents fail.
 */
const agentCallCounts = new Map<string, number>();

vi.mock('../src/agent/agent-executor/executor', () => ({
  executeAgent: vi.fn(async (agentId: string, _stateView: any, _tools: any, attempt: number) => {
    const count = (agentCallCounts.get(agentId) || 0) + 1;
    agentCallCounts.set(agentId, count);

    // 'always-fail' agent always throws
    if (agentId === 'always-fail') {
      throw new Error(`Agent ${agentId} permanently failed (call ${count})`);
    }

    // 'slow-agent' delays to allow shutdown to be requested mid-execution
    if (agentId === 'slow-agent') {
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    return {
      id: uuidv4(),
      idempotency_key: `${agentId}:${count}:${attempt}`,
      type: 'update_memory',
      payload: { updates: { [`${agentId}_result`]: `done_call_${count}` } },
      metadata: { node_id: agentId, agent_id: agentId, timestamp: new Date(), attempt },
      // Include compensation for nodes that require it
      ...(agentId === 'compensatable-agent' ? {
        compensation: {
          id: uuidv4(),
          idempotency_key: `comp-${agentId}:${count}`,
          type: 'update_memory',
          payload: { updates: { [`${agentId}_result`]: 'rolled_back' } },
          metadata: { node_id: agentId, timestamp: new Date(), attempt: 1 },
        },
      } : {}),
    };
  }),
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

// Mock sleep to avoid slow tests
vi.mock('../src/runner/helpers', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    sleep: vi.fn().mockResolvedValue(undefined),
  };
});

import { GraphRunner } from '../src/runner/graph-runner.js';
import type { Graph, GraphNode } from '../src/types/graph.js';
import type { WorkflowState } from '../src/types/state.js';

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
  goal: 'Rollback test',
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

// ─── Task 1.5: Auto-Rollback Tests ─────────────────────────────────────

describe('GraphRunner — Auto-Rollback on Failure', () => {
  /**
   * When auto_rollback is true and a node fails after a compensatable node
   * has pushed compensation actions, rollback() should execute in LIFO order
   * and the workflow should end in 'cancelled' status (not 'failed').
   */
  test('should run LIFO compensation and set status to cancelled with auto_rollback: true', async () => {
    const graph: Graph = {
      id: uuidv4(), name: 'Auto Rollback', description: '',
      nodes: [
        makeNode({
          id: 'step1', type: 'agent', agent_id: 'compensatable-agent',
          requires_compensation: true,
        }),
        makeNode({
          id: 'step2', type: 'agent', agent_id: 'always-fail',
          failure_policy: { max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 10, max_backoff_ms: 10 },
        }),
      ],
      edges: [
        { id: 'e1', source: 'step1', target: 'step2', condition: { type: 'always' } },
      ],
      start_node: 'step1',
      end_nodes: ['step2'],
    };

    const persistSpy = vi.fn().mockResolvedValue(undefined);
    const runner = new GraphRunner(graph, createState(), {
      persistStateFn: persistSpy,
      auto_rollback: true,
    });

    const rollbackSpy = vi.fn();
    runner.on('workflow:rollback', rollbackSpy);

    // auto_rollback catches the error internally; run() should still throw
    // because the workflow is not in a completed state
    try {
      await runner.run();
    } catch {
      // expected — the error propagates after rollback
    }

    // Rollback event should have been emitted
    expect(rollbackSpy).toHaveBeenCalledOnce();

    // Last persisted state should be 'cancelled' (from rollback), not 'failed'
    const lastPersisted = persistSpy.mock.calls[persistSpy.mock.calls.length - 1][0] as WorkflowState;
    expect(lastPersisted.status).toBe('cancelled');

    // Compensation should have been applied
    expect(lastPersisted.memory['compensatable-agent_result']).toBe('rolled_back');

    // Compensation stack should be drained
    expect(lastPersisted.compensation_stack).toHaveLength(0);
  });

  /**
   * Default behavior (auto_rollback: false): compensation should NOT run
   * on failure. Status should be 'failed'.
   */
  test('should NOT run compensation with auto_rollback: false (default)', async () => {
    const graph: Graph = {
      id: uuidv4(), name: 'No Auto Rollback', description: '',
      nodes: [
        makeNode({
          id: 'step1', type: 'agent', agent_id: 'compensatable-agent',
          requires_compensation: true,
        }),
        makeNode({
          id: 'step2', type: 'agent', agent_id: 'always-fail',
          failure_policy: { max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 10, max_backoff_ms: 10 },
        }),
      ],
      edges: [
        { id: 'e1', source: 'step1', target: 'step2', condition: { type: 'always' } },
      ],
      start_node: 'step1',
      end_nodes: ['step2'],
    };

    const persistSpy = vi.fn().mockResolvedValue(undefined);
    const runner = new GraphRunner(graph, createState(), { persistStateFn: persistSpy });

    const rollbackSpy = vi.fn();
    runner.on('workflow:rollback', rollbackSpy);

    try {
      await runner.run();
    } catch {
      // expected
    }

    // Rollback should NOT have been called
    expect(rollbackSpy).not.toHaveBeenCalled();

    // Status should be 'failed'
    const lastPersisted = persistSpy.mock.calls[persistSpy.mock.calls.length - 1][0] as WorkflowState;
    expect(lastPersisted.status).toBe('failed');

    // Compensation stack should still have entries (not drained)
    expect(lastPersisted.compensation_stack.length).toBeGreaterThan(0);
  });

  /**
   * auto_rollback with no compensation entries should skip rollback
   * and proceed with normal failure handling.
   */
  test('should skip rollback when compensation stack is empty', async () => {
    const graph: Graph = {
      id: uuidv4(), name: 'Empty Comp Stack', description: '',
      nodes: [
        makeNode({
          id: 'step1', type: 'agent', agent_id: 'always-fail',
          failure_policy: { max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 10, max_backoff_ms: 10 },
        }),
      ],
      edges: [],
      start_node: 'step1',
      end_nodes: ['step1'],
    };

    const persistSpy = vi.fn().mockResolvedValue(undefined);
    const failedSpy = vi.fn();
    const runner = new GraphRunner(graph, createState(), {
      persistStateFn: persistSpy,
      auto_rollback: true,
    });
    runner.on('workflow:failed', failedSpy);

    try {
      await runner.run();
    } catch {
      // expected
    }

    // workflow:failed should have been emitted (normal failure path)
    expect(failedSpy).toHaveBeenCalledOnce();
    const lastPersisted = persistSpy.mock.calls[persistSpy.mock.calls.length - 1][0] as WorkflowState;
    expect(lastPersisted.status).toBe('failed');
  });
});

// ─── Task 1.6: Approval Gate Timeout Tests ──────────────────────────────

describe('GraphRunner — Approval Gate Timeout', () => {
  /**
   * When request_human_input sets a waiting_timeout_at and no human response
   * is provided, the workflow should eventually time out.
   */
  test('should timeout when approval gate expires', async () => {
    const graph: Graph = {
      id: 'timeout-hitl',
      name: 'Timeout HITL',
      description: 'Tests approval timeout',
      nodes: [
        makeNode({ id: 'agent1', type: 'agent', agent_id: 'writer' }),
        {
          id: 'review',
          type: 'approval',
          approval_config: {
            approval_type: 'human_review',
            prompt_message: 'Review please.',
            review_keys: ['draft'],
            timeout_ms: 60000, // Will be overridden by our expired state
          },
          read_keys: ['*'],
          write_keys: ['*', 'control_flow'],
          failure_policy: { max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 100, max_backoff_ms: 100 },
          requires_compensation: false,
        },
        makeNode({ id: 'publish', type: 'agent', agent_id: 'publisher' }),
      ],
      edges: [
        { id: 'e1', source: 'agent1', target: 'review', condition: { type: 'always' } },
        { id: 'e2', source: 'review', target: 'publish', condition: { type: 'always' } },
      ],
      start_node: 'agent1',
      end_nodes: ['publish'],
    };

    // Step 1: Run workflow to get it into 'waiting' state at the approval node
    const state = createState({ memory: { draft: 'content' }, max_execution_time_ms: 30000 });
    const runner1 = new GraphRunner(graph, state);
    const pausedState = await runner1.run();
    expect(pausedState.status).toBe('waiting');
    expect(pausedState.waiting_timeout_at).toBeDefined();

    // Step 2: Simulate timeout by setting waiting_timeout_at to the past
    const expiredState = {
      ...pausedState,
      waiting_timeout_at: new Date(Date.now() - 1000), // 1 second ago
    };

    // Step 3: Resume with expired timeout — should transition to 'timeout'
    const runner2 = new GraphRunner(graph, expiredState);
    try {
      await runner2.run();
      // Should have thrown
      expect(true).toBe(false);
    } catch (error) {
      expect((error as Error).message).toMatch(/timed out/i);
    }
  });
});

// ─── Task 4.4: Graceful Shutdown Tests ──────────────────────────────────

describe('GraphRunner — Graceful Shutdown', () => {
  /**
   * shutdown() during execution should let the current node complete,
   * persist state, and emit workflow:paused. The workflow should still
   * be in 'running' status (resumable).
   */
  test('should pause after current node completes on shutdown()', async () => {
    const graph: Graph = {
      id: uuidv4(), name: 'Shutdown Test', description: '',
      nodes: [
        makeNode({ id: 'node-a', type: 'agent', agent_id: 'slow-agent' }),
        makeNode({ id: 'node-b', type: 'agent', agent_id: 'good-agent' }),
      ],
      edges: [
        { id: 'e1', source: 'node-a', target: 'node-b', condition: { type: 'always' } },
      ],
      start_node: 'node-a',
      end_nodes: ['node-b'],
    };

    const persistSpy = vi.fn().mockResolvedValue(undefined);
    const pausedSpy = vi.fn();

    const runner = new GraphRunner(graph, createState(), { persistStateFn: persistSpy });
    runner.on('workflow:paused', pausedSpy);

    // Request shutdown after a brief delay (node-a should already be executing)
    setTimeout(() => runner.shutdown(), 10);

    const finalState = await runner.run();

    // workflow:paused should have been emitted
    expect(pausedSpy).toHaveBeenCalledOnce();
    expect(pausedSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        workflow_id: finalState.workflow_id,
        run_id: finalState.run_id,
      })
    );

    // State should be 'running' (paused, not cancelled or completed)
    expect(finalState.status).toBe('running');

    // First node should have completed
    expect(finalState.visited_nodes).toContain('node-a');

    // Second node should NOT have been reached
    expect(finalState.visited_nodes).not.toContain('node-b');

    // State should have been persisted
    expect(persistSpy).toHaveBeenCalled();
  });

  /**
   * shutdown() before execution starts should stop after the first node.
   */
  test('should stop after first node if shutdown() called immediately', async () => {
    const graph: Graph = {
      id: uuidv4(), name: 'Immediate Shutdown', description: '',
      nodes: [
        makeNode({ id: 'first', type: 'agent', agent_id: 'good-agent' }),
        makeNode({ id: 'second', type: 'agent', agent_id: 'good-agent' }),
      ],
      edges: [
        { id: 'e1', source: 'first', target: 'second', condition: { type: 'always' } },
      ],
      start_node: 'first',
      end_nodes: ['second'],
    };

    const runner = new GraphRunner(graph, createState());

    // Request shutdown immediately — the first node will still execute
    runner.shutdown();
    const finalState = await runner.run();

    expect(finalState.status).toBe('running');
    expect(finalState.visited_nodes).toContain('first');
    expect(finalState.visited_nodes).not.toContain('second');
  });

  /**
   * stream() should yield a workflow:paused event on shutdown.
   */
  test('should yield workflow:paused event when streaming', async () => {
    const graph: Graph = {
      id: uuidv4(), name: 'Stream Shutdown', description: '',
      nodes: [
        makeNode({ id: 'first', type: 'agent', agent_id: 'good-agent' }),
        makeNode({ id: 'second', type: 'agent', agent_id: 'good-agent' }),
      ],
      edges: [
        { id: 'e1', source: 'first', target: 'second', condition: { type: 'always' } },
      ],
      start_node: 'first',
      end_nodes: ['second'],
    };

    const runner = new GraphRunner(graph, createState());
    runner.shutdown();

    const events: any[] = [];
    for await (const event of runner.stream()) {
      events.push(event);
    }

    const pausedEvent = events.find(e => e.type === 'workflow:paused');
    expect(pausedEvent).toBeDefined();
    expect(pausedEvent.workflow_id).toBeDefined();
    expect(pausedEvent.run_id).toBeDefined();
  });
});
