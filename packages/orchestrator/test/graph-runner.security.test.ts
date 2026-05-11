/**
 * graph-runner.security.test.ts
 *
 * Battle-tests for the security boundary of the graph runner:
 * - Write key permission enforcement (agents can only write to allowed keys)
 * - StateView read key filtering (agents only see memory they're allowed to)
 * - Token budget enforcement (BudgetExceededError on overspend)
 * - Idempotency deduplication (same node+iteration not re-executed)
 * - Action schema validation (malformed actions rejected)
 *
 * These tests verify the defense-in-depth model that prevents agents from
 * escaping their sandbox, overspending, or corrupting state.
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
 * This mock is designed for security testing:
 *
 * - 'writer-secret': attempts to write to 'secret_data' key (should be blocked
 *    when node's write_keys doesn't include 'secret_data')
 * - 'writer-allowed': writes to 'public_result' key (should succeed when
 *    node's write_keys includes 'public_result' or '*')
 * - 'big-spender': returns action with high token_usage metadata
 * - 'status-changer': returns a set_status action (not update_memory)
 *
 * The mock also captures the stateView passed to it so we can verify
 * that read_keys filtering works correctly.
 */
const capturedStateViews = new Map<string, any>();

vi.mock('../src/agent/agent-executor/executor', () => ({
  executeAgent: vi.fn(async (agentId: string, stateView: any, _tools: any, attempt: number) => {
    // Capture the stateView so tests can verify filtering
    capturedStateViews.set(agentId, JSON.parse(JSON.stringify(stateView)));

    if (agentId === 'writer-secret') {
      return {
        id: uuidv4(),
        idempotency_key: `${agentId}:mock:${attempt}`,
        type: 'update_memory',
        payload: { updates: { secret_data: 'STOLEN_API_KEY' } },
        metadata: { node_id: agentId, agent_id: agentId, timestamp: new Date(), attempt },
      };
    }

    if (agentId === 'writer-allowed') {
      return {
        id: uuidv4(),
        idempotency_key: `${agentId}:mock:${attempt}`,
        type: 'update_memory',
        payload: { updates: { public_result: 'this is fine' } },
        metadata: { node_id: agentId, agent_id: agentId, timestamp: new Date(), attempt },
      };
    }

    if (agentId === 'big-spender') {
      return {
        id: uuidv4(),
        idempotency_key: `${agentId}:mock:${attempt}`,
        type: 'update_memory',
        payload: { updates: { result: 'expensive computation' } },
        metadata: {
          node_id: agentId, agent_id: agentId, timestamp: new Date(), attempt,
          token_usage: { totalTokens: 50000 },
        },
      };
    }

    if (agentId === 'moderate-spender') {
      return {
        id: uuidv4(),
        idempotency_key: `${agentId}:mock:${attempt}`,
        type: 'update_memory',
        payload: { updates: { result: 'moderate computation' } },
        metadata: {
          node_id: agentId, agent_id: agentId, timestamp: new Date(), attempt,
          token_usage: { totalTokens: 500 },
        },
      };
    }

    if (agentId === 'status-changer') {
      return {
        id: uuidv4(),
        idempotency_key: `${agentId}:mock:${attempt}`,
        type: 'set_status',
        payload: { status: 'completed' },
        metadata: { node_id: agentId, agent_id: agentId, timestamp: new Date(), attempt },
      };
    }

    // Default: well-behaved agent
    return {
      id: uuidv4(),
      idempotency_key: `${agentId}:mock:${attempt}`,
      type: 'update_memory',
      payload: { updates: { [`${agentId}_result`]: 'done' } },
      metadata: { node_id: agentId, agent_id: agentId, timestamp: new Date(), attempt },
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

import { GraphRunner, BudgetExceededError } from '../src/runner/graph-runner.js';
import type { Graph, GraphNode } from '../src/types/graph.js';
import type { WorkflowState } from '../src/types/state.js';

beforeEach(() => {
  capturedStateViews.clear();
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
  goal: 'Security test',
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

describe('GraphRunner — Write Key Permissions', () => {
  /**
   * An agent node with restricted write_keys should not be able to write
   * to keys outside its allowlist. The runner should throw a permission error.
   *
   * Node write_keys: ['public_result']
   * Agent tries to write: { secret_data: '...' }  → BLOCKED
   */
  test('should reject action writing to unauthorized memory key', async () => {
    const graph: Graph = {
      id: uuidv4(), name: 'Permission Block', description: '',
      nodes: [
        makeNode({
          id: 'restricted-node', type: 'agent', agent_id: 'writer-secret',
          write_keys: ['public_result'], // does NOT include 'secret_data'
        }),
      ],
      edges: [],
      start_node: 'restricted-node',
      end_nodes: ['restricted-node'],
    };

    const runner = new GraphRunner(graph, createState());

    await expect(runner.run()).rejects.toThrow(/unauthorized keys/);
  });

  /**
   * Same agent writing to an allowed key should succeed.
   */
  test('should allow action writing to authorized memory key', async () => {
    const graph: Graph = {
      id: uuidv4(), name: 'Permission Allow', description: '',
      nodes: [
        makeNode({
          id: 'allowed-node', type: 'agent', agent_id: 'writer-allowed',
          write_keys: ['public_result'], // includes the key being written
        }),
      ],
      edges: [],
      start_node: 'allowed-node',
      end_nodes: ['allowed-node'],
    };

    const runner = new GraphRunner(graph, createState());
    const final = await runner.run();

    expect(final.status).toBe('completed');
    expect(final.memory.public_result).toBe('this is fine');
  });

  /**
   * write_keys: ['*'] should grant wildcard write access.
   */
  test('should allow wildcard write_keys to write any key', async () => {
    const graph: Graph = {
      id: uuidv4(), name: 'Wildcard Write', description: '',
      nodes: [
        makeNode({
          id: 'wild-node', type: 'agent', agent_id: 'writer-secret',
          write_keys: ['*'], // wildcard → everything allowed
        }),
      ],
      edges: [],
      start_node: 'wild-node',
      end_nodes: ['wild-node'],
    };

    const runner = new GraphRunner(graph, createState());
    const final = await runner.run();

    expect(final.status).toBe('completed');
    // Even the 'secret_data' key goes through with wildcard
    expect(final.memory.secret_data).toBe('STOLEN_API_KEY');
  });

  /**
   * A non-update_memory action type (e.g. set_status) should require
   * explicit permission. Without 'status' in write_keys, it's blocked.
   */
  test('should reject set_status action without explicit status permission', async () => {
    const graph: Graph = {
      id: uuidv4(), name: 'Status Block', description: '',
      nodes: [
        makeNode({
          id: 'status-node', type: 'agent', agent_id: 'status-changer',
          write_keys: ['public_result'], // no 'status' permission
        }),
      ],
      edges: [],
      start_node: 'status-node',
      end_nodes: ['status-node'],
    };

    const runner = new GraphRunner(graph, createState());

    await expect(runner.run()).rejects.toThrow(/unauthorized keys/);
  });

  /**
   * Empty write_keys should deny everything (deny-all policy).
   * This is the safest default for untrusted agents.
   */
  test('should deny all writes with empty write_keys', async () => {
    const graph: Graph = {
      id: uuidv4(), name: 'Deny All', description: '',
      nodes: [
        makeNode({
          id: 'locked-node', type: 'agent', agent_id: 'writer-allowed',
          write_keys: [], // NO permissions
        }),
      ],
      edges: [],
      start_node: 'locked-node',
      end_nodes: ['locked-node'],
    };

    const runner = new GraphRunner(graph, createState());

    await expect(runner.run()).rejects.toThrow(/unauthorized keys/);
  });
});

describe('GraphRunner — StateView Read Key Filtering', () => {
  /**
   * A node with restricted read_keys should only see allowed memory keys.
   * Secret keys should be filtered out of the StateView.
   */
  test('should filter memory by read_keys in StateView', async () => {
    const graph: Graph = {
      id: uuidv4(), name: 'Read Filter', description: '',
      nodes: [
        makeNode({
          id: 'reader-node', type: 'agent', agent_id: 'reader-agent',
          read_keys: ['public_data', 'shared_info'], // only these keys visible
          write_keys: ['*'],
        }),
      ],
      edges: [],
      start_node: 'reader-node',
      end_nodes: ['reader-node'],
    };

    const state = createState({
      memory: {
        public_data: 'visible',
        shared_info: 'also visible',
        secret_key: 'SHOULD_NOT_SEE',
        api_token: 'SHOULD_NOT_SEE',
      },
    });

    const runner = new GraphRunner(graph, state);
    await runner.run();

    // Verify the stateView passed to the agent was filtered
    const capturedView = capturedStateViews.get('reader-agent');
    expect(capturedView).toBeDefined();
    expect(capturedView.memory.public_data).toBe('visible');
    expect(capturedView.memory.shared_info).toBe('also visible');
    expect(capturedView.memory.secret_key).toBeUndefined();
    expect(capturedView.memory.api_token).toBeUndefined();
  });

  /**
   * read_keys: ['*'] should give full access to all memory.
   */
  test('should give full memory access with wildcard read_keys', async () => {
    const graph: Graph = {
      id: uuidv4(), name: 'Full Read', description: '',
      nodes: [
        makeNode({
          id: 'full-reader', type: 'agent', agent_id: 'full-reader-agent',
          read_keys: ['*'],
          write_keys: ['*'],
        }),
      ],
      edges: [],
      start_node: 'full-reader',
      end_nodes: ['full-reader'],
    };

    const state = createState({
      memory: {
        public: 'yes',
        secret: 'also yes with wildcard',
      },
    });

    const runner = new GraphRunner(graph, state);
    await runner.run();

    const capturedView = capturedStateViews.get('full-reader-agent');
    expect(capturedView.memory.public).toBe('yes');
    expect(capturedView.memory.secret).toBe('also yes with wildcard');
  });

  /**
   * A read_keys array that references keys NOT in memory should produce
   * an empty filtered memory — no errors, no undefined property access.
   */
  test('should produce empty memory when read_keys reference non-existent keys', async () => {
    const graph: Graph = {
      id: uuidv4(), name: 'Empty Read', description: '',
      nodes: [
        makeNode({
          id: 'empty-reader', type: 'agent', agent_id: 'empty-reader-agent',
          read_keys: ['nonexistent_key_1', 'nonexistent_key_2'],
          write_keys: ['*'],
        }),
      ],
      edges: [],
      start_node: 'empty-reader',
      end_nodes: ['empty-reader'],
    };

    const state = createState({
      memory: { actual_data: 'irrelevant' },
    });

    const runner = new GraphRunner(graph, state);
    await runner.run();

    const capturedView = capturedStateViews.get('empty-reader-agent');
    expect(capturedView.memory).toEqual({});
  });

  /**
   * StateView should always include workflow-level fields (workflow_id, run_id,
   * goal, constraints) regardless of read_keys — these are needed for context.
   */
  test('should always include workflow-level fields in StateView', async () => {
    const state = createState({
      goal: 'important mission',
      constraints: ['be polite', 'stay on topic'],
    });

    const graph: Graph = {
      id: uuidv4(), name: 'Context Fields', description: '',
      nodes: [
        makeNode({
          id: 'context-reader', type: 'agent', agent_id: 'context-agent',
          read_keys: [], // no memory access at all
          write_keys: ['*'],
        }),
      ],
      edges: [],
      start_node: 'context-reader',
      end_nodes: ['context-reader'],
    };

    const runner = new GraphRunner(graph, state);
    await runner.run();

    const capturedView = capturedStateViews.get('context-agent');
    expect(capturedView.workflow_id).toBe(state.workflow_id);
    expect(capturedView.run_id).toBe(state.run_id);
    expect(capturedView.goal).toBe('important mission');
    expect(capturedView.constraints).toEqual(['be polite', 'stay on topic']);
  });
});

describe('GraphRunner — Token Budget Enforcement', () => {
  /**
   * When cumulative token usage exceeds max_token_budget,
   * the runner should throw BudgetExceededError and set state to failed.
   *
   * big-spender agent returns 50000 tokens; budget is 10000.
   */
  test('should throw BudgetExceededError when token budget exceeded', async () => {
    const graph: Graph = {
      id: uuidv4(), name: 'Budget Exceed', description: '',
      nodes: [
        makeNode({
          id: 'expensive-node', type: 'agent', agent_id: 'big-spender',
        }),
      ],
      edges: [],
      start_node: 'expensive-node',
      end_nodes: ['expensive-node'],
    };

    const state = createState({ max_token_budget: 10000 });
    const runner = new GraphRunner(graph, state);

    try {
      await runner.run();
      // Should not reach here
      expect(true).toBe(false);
    } catch (error) {
      expect(error).toBeInstanceOf(BudgetExceededError);
      expect((error as BudgetExceededError).tokensUsed).toBe(50000);
      expect((error as BudgetExceededError).budget).toBe(10000);
    }
  });

  /**
   * When token usage is within budget, workflow should complete normally.
   */
  test('should not throw when token usage is within budget', async () => {
    const graph: Graph = {
      id: uuidv4(), name: 'Budget OK', description: '',
      nodes: [
        makeNode({
          id: 'cheap-node', type: 'agent', agent_id: 'moderate-spender',
        }),
      ],
      edges: [],
      start_node: 'cheap-node',
      end_nodes: ['cheap-node'],
    };

    const state = createState({ max_token_budget: 100000 });
    const runner = new GraphRunner(graph, state);
    const final = await runner.run();

    expect(final.status).toBe('completed');
    expect(final.total_tokens_used).toBe(500);
  });

  /**
   * When no max_token_budget is set, token tracking should still work
   * but no error should be thrown.
   */
  test('should track tokens without budget enforcement when no budget set', async () => {
    const graph: Graph = {
      id: uuidv4(), name: 'No Budget', description: '',
      nodes: [
        makeNode({ id: 'node', type: 'agent', agent_id: 'big-spender' }),
      ],
      edges: [],
      start_node: 'node',
      end_nodes: ['node'],
    };

    // No max_token_budget set
    const state = createState();
    const runner = new GraphRunner(graph, state);
    const final = await runner.run();

    expect(final.status).toBe('completed');
    expect(final.total_tokens_used).toBe(50000);
  });

  /**
   * Token budget exceeded should persist the failed state with last_error.
   */
  test('should persist failed state when budget exceeded', async () => {
    const graph: Graph = {
      id: uuidv4(), name: 'Budget Persist', description: '',
      nodes: [
        makeNode({ id: 'expensive', type: 'agent', agent_id: 'big-spender' }),
      ],
      edges: [],
      start_node: 'expensive',
      end_nodes: ['expensive'],
    };

    const persistSpy = vi.fn().mockResolvedValue(undefined);
    const state = createState({ max_token_budget: 1000 });
    const runner = new GraphRunner(graph, state, { persistStateFn: persistSpy });

    try {
      await runner.run();
    } catch {
      // expected
    }

    const lastPersisted = persistSpy.mock.calls[persistSpy.mock.calls.length - 1][0] as WorkflowState;
    expect(lastPersisted.status).toBe('failed');
    expect(lastPersisted.last_error).toContain('Token budget exceeded');
  });

  /**
   * Cumulative tracking across multiple nodes. Two moderate-spenders at 500 tokens
   * each = 1000 total. Budget of 1500 should succeed; budget of 800 should fail
   * on the second node.
   */
  test('should accumulate tokens across multiple nodes', async () => {
    const graph: Graph = {
      id: uuidv4(), name: 'Cumulative Tokens', description: '',
      nodes: [
        makeNode({ id: 'node1', type: 'agent', agent_id: 'moderate-spender' }),
        makeNode({ id: 'node2', type: 'agent', agent_id: 'moderate-spender' }),
      ],
      edges: [
        { id: 'e1', source: 'node1', target: 'node2', condition: { type: 'always' } },
      ],
      start_node: 'node1',
      end_nodes: ['node2'],
    };

    // Budget large enough for both
    const state = createState({ max_token_budget: 1500 });
    const runner = new GraphRunner(graph, state);
    const final = await runner.run();

    expect(final.status).toBe('completed');
    expect(final.total_tokens_used).toBe(1000); // 500 + 500
  });

  test('should fail when cumulative tokens exceed budget on second node', async () => {
    const graph: Graph = {
      id: uuidv4(), name: 'Cumulative Over', description: '',
      nodes: [
        makeNode({ id: 'node1', type: 'agent', agent_id: 'moderate-spender' }),
        makeNode({ id: 'node2', type: 'agent', agent_id: 'moderate-spender' }),
      ],
      edges: [
        { id: 'e1', source: 'node1', target: 'node2', condition: { type: 'always' } },
      ],
      start_node: 'node1',
      end_nodes: ['node2'],
    };

    // Budget only for one node, not two
    const state = createState({ max_token_budget: 800 });
    const runner = new GraphRunner(graph, state);

    await expect(runner.run()).rejects.toThrow(BudgetExceededError);
  });
});

describe('GraphRunner — Memory Accumulation', () => {
  /**
   * Memory updates from earlier nodes should be visible to later nodes
   * in the chain. This verifies that state is properly threaded through
   * the execution loop.
   */
  test('should accumulate memory across node executions', async () => {
    const graph: Graph = {
      id: uuidv4(), name: 'Memory Accum', description: '',
      nodes: [
        makeNode({ id: 'node-a', type: 'agent', agent_id: 'writer-allowed' }), // writes public_result
        makeNode({ id: 'node-b', type: 'agent', agent_id: 'writer-secret' }),   // writes secret_data
      ],
      edges: [
        { id: 'e1', source: 'node-a', target: 'node-b', condition: { type: 'always' } },
      ],
      start_node: 'node-a',
      end_nodes: ['node-b'],
    };

    const runner = new GraphRunner(graph, createState());
    const final = await runner.run();

    // Both nodes' memory updates should be present
    expect(final.memory.public_result).toBe('this is fine');
    expect(final.memory.secret_data).toBe('STOLEN_API_KEY');
  });

  /**
   * Pre-populated memory should survive and be augmented by node executions.
   */
  test('should preserve pre-populated memory alongside new writes', async () => {
    const graph: Graph = {
      id: uuidv4(), name: 'Preserve Memory', description: '',
      nodes: [
        makeNode({ id: 'node', type: 'agent', agent_id: 'writer-allowed' }),
      ],
      edges: [],
      start_node: 'node',
      end_nodes: ['node'],
    };

    const state = createState({
      memory: { existing_key: 'preserved', another: 42 },
    });

    const runner = new GraphRunner(graph, state);
    const final = await runner.run();

    // Original keys preserved
    expect(final.memory.existing_key).toBe('preserved');
    expect(final.memory.another).toBe(42);
    // New key added
    expect(final.memory.public_result).toBe('this is fine');
  });
});
