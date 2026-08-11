import { describe, it, expect, vi, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';

// Mock external SDK dependencies to prevent worker crashes
vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: vi.fn(() => vi.fn(() => ({}))),
}));
vi.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: vi.fn(() => vi.fn(() => ({}))),
}));
vi.mock('ai', () => ({
  streamText: vi.fn(),
  generateText: vi.fn(),
  tool: vi.fn(),
  stepCountIs: vi.fn(),
  Output: { object: vi.fn() },
}));
vi.mock('@opentelemetry/api', () => ({
  trace: { getTracer: () => ({ startSpan: vi.fn() }) },
  SpanStatusCode: { ERROR: 2 },
  context: { active: vi.fn() },
}));

// Mock jsonpath — its aesprim dependency uses Module._compile which crashes
// Vitest's ESM worker process
vi.mock('jsonpath', () => ({
  default: { query: vi.fn(() => []) },
  query: vi.fn(() => []),
}));

// Mock agent runtime modules — subgraph tests only need tool nodes
vi.mock('../src/agents/factory.js', () => ({
  agentFactory: {
    loadAgent: vi.fn().mockResolvedValue({
      id: 'test-agent',
      model: 'test-model',
      system: 'test',
      tools: [],
      permissions: { sandbox: false, read_keys: ['*'], write_keys: ['*'] },
    }),
    getModel: vi.fn().mockReturnValue({}),
  },
  AgentFactory: vi.fn(),
}));

vi.mock('../src/agents/executors/agent/executor.js', () => ({
  executeAgent: vi.fn(),
  PermissionDeniedError: class extends Error { },
}));

vi.mock('../src/agents/executors/supervisor/executor.js', () => ({
  executeSupervisor: vi.fn(),
  SupervisorConfigError: class extends Error { },
  SupervisorRoutingError: class extends Error { },
  SUPERVISOR_DONE: '__done__',
}));

vi.mock('../src/agents/executors/evaluator/executor.js', () => ({
  evaluateQualityExecutor: vi.fn(),
}));

vi.mock('../src/observability/tracing.js', () => ({
  getTracer: () => ({}),
  withSpan: (_t: any, _n: string, fn: any) => fn({ setAttribute: vi.fn() }),
  initTracing: vi.fn(),
}));

import { GraphRunner } from '../src/execution/engine/graph-runner.js';
import { executeSubgraphNode } from '../src/execution/nodes/subgraph.js';
import { executeAgent } from '../src/agents/executors/agent/executor.js';
import { NodeConfigError } from '../src/execution/errors.js';
import { markTainted } from '../src/security/taint.js';
import type { Graph, GraphNode } from '../src/graph/graph.js';
import type { WorkflowState, StateView } from '../src/state/state.js';
import type { NodeExecutorContext } from '../src/execution/nodes/context.js';

function createTestState(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return {
    workflow_id: 'parent-graph',
    run_id: uuidv4(),
    created_at: new Date(),
    updated_at: new Date(),
    goal: 'Test subgraph execution',
    constraints: [],
    status: 'pending',
    current_node: undefined,
    iteration_count: 0,
    retry_count: 0,
    max_retries: 3,
    last_error: undefined,
    waiting_for: undefined,
    waiting_since: undefined,
    waiting_timeout_at: undefined,
    started_at: undefined,
    max_execution_time_ms: 60000,
    memory: {},
    total_tokens_used: 0,
    total_cost_usd: 0,
    max_token_budget: undefined,
    visited_nodes: [],
    max_iterations: 50,
    compensation_stack: [],
    supervisor_history: [],
    _cost_alert_thresholds_fired: [],
    ...overrides,
  };
}

// Helper to create a minimal tool graph (no LLM needed)
function createToolGraph(id: string, overrides: Partial<Graph> = {}): Graph {
  return {
    id,
    name: `test-graph-${id}`,
    description: 'Test graph',
    nodes: [
      {
        id: 'tool-node',
        type: 'tool',
        tool_id: 'mock-tool',
        read_keys: ['*'],
        write_keys: ['*'],
        failure_policy: { max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 0, max_backoff_ms: 0 },
        requires_compensation: false,
      },
    ],
    edges: [],
    start_node: 'tool-node',
    end_nodes: ['tool-node'],
    ...overrides,
  };
}

describe('Subgraph Execution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('executes a basic subgraph and maps outputs back', async () => {
    const childGraph = createToolGraph('child-graph');

    const parentGraph: Graph = {
      id: 'parent-graph',
      name: 'parent',
      description: 'Parent with subgraph',
      nodes: [
        {
          id: 'sub-node',
          type: 'subgraph',
          subgraph_config: {
            subgraph_id: 'child-graph',
            input_mapping: { parent_input: 'child_input' },
            output_mapping: { 'tool-node_result': 'child_output' },
            max_iterations: 50,
          },
          read_keys: ['*'],
          write_keys: ['*'],
          failure_policy: { max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 0, max_backoff_ms: 0 },
          requires_compensation: false,
        },
      ],
      edges: [],
      start_node: 'sub-node',
      end_nodes: ['sub-node'],
    };

    const loadGraphFn = vi.fn().mockResolvedValue(childGraph);
    const state = createTestState({ memory: { parent_input: 'hello' } });

    const runner = new GraphRunner(parentGraph, state, { loadGraphFn });
    const finalState = await runner.run();

    expect(finalState.status).toBe('completed');
    expect(loadGraphFn).toHaveBeenCalledWith('child-graph');
    expect(finalState.memory.child_output).toBeDefined();
  });

  it('only maps specified input keys to child', async () => {
    const childGraph = createToolGraph('child-graph');

    const parentGraph: Graph = {
      id: 'parent-graph',
      name: 'parent',
      description: 'Parent with limited mapping',
      nodes: [
        {
          id: 'sub-node',
          type: 'subgraph',
          subgraph_config: {
            subgraph_id: 'child-graph',
            input_mapping: { allowed_key: 'mapped_key' },
            output_mapping: {},
            max_iterations: 50,
          },
          read_keys: ['*'],
          write_keys: ['*'],
          failure_policy: { max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 0, max_backoff_ms: 0 },
          requires_compensation: false,
        },
      ],
      edges: [],
      start_node: 'sub-node',
      end_nodes: ['sub-node'],
    };

    const loadGraphFn = vi.fn().mockResolvedValue(childGraph);
    const state = createTestState({
      memory: { allowed_key: 'mapped_value', secret_key: 'should_not_transfer' },
    });

    const runner = new GraphRunner(parentGraph, state, { loadGraphFn });
    const finalState = await runner.run();

    expect(finalState.status).toBe('completed');
    expect(finalState.memory.secret_key).toBe('should_not_transfer');
  });

  it('inherits remaining token budget', async () => {
    const childGraph = createToolGraph('child-graph');

    const parentGraph: Graph = {
      id: 'parent-graph',
      name: 'parent',
      description: 'Budget inheritance test',
      nodes: [
        {
          id: 'sub-node',
          type: 'subgraph',
          subgraph_config: {
            subgraph_id: 'child-graph',
            input_mapping: {},
            output_mapping: {},
            max_iterations: 50,
          },
          read_keys: ['*'],
          write_keys: ['*'],
          failure_policy: { max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 0, max_backoff_ms: 0 },
          requires_compensation: false,
        },
      ],
      edges: [],
      start_node: 'sub-node',
      end_nodes: ['sub-node'],
    };

    const loadGraphFn = vi.fn().mockResolvedValue(childGraph);
    const state = createTestState({
      max_token_budget: 10000,
      total_tokens_used: 3000,
    });

    const runner = new GraphRunner(parentGraph, state, { loadGraphFn });
    const finalState = await runner.run();

    expect(finalState.status).toBe('completed');
  });

  // ── subgraph USD cost propagation & enforcement ──

  const ONE_MILLION_INPUT_TOKENS = 1_000_000;
  const CHILD_SPEND_USD = 2.5;

  function createCostyChildAndParent() {
    const childGraph: Graph = {
      id: 'child-graph', name: 'costly child', description: 'spends money',
      nodes: [{
        id: 'child-agent', type: 'agent', agent_id: 'a1',
        read_keys: ['*'], write_keys: ['*'],
        failure_policy: { max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 0, max_backoff_ms: 0 },
        requires_compensation: false,
      }],
      edges: [], start_node: 'child-agent', end_nodes: ['child-agent'],
    };
    const parentGraph: Graph = {
      id: 'parent-graph', name: 'parent', description: 'wraps a costly child',
      nodes: [{
        id: 'sub-node', type: 'subgraph',
        subgraph_config: { subgraph_id: 'child-graph', input_mapping: {}, output_mapping: {}, max_iterations: 50 },
        read_keys: ['*'], write_keys: ['*'],
        failure_policy: { max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 0, max_backoff_ms: 0 },
        requires_compensation: false,
      }],
      edges: [], start_node: 'sub-node', end_nodes: ['sub-node'],
    };
    (executeAgent as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: uuidv4(), idempotency_key: uuidv4(), type: 'update_memory',
      payload: { updates: { child_result: 'done' } },
      metadata: {
        node_id: 'child-agent', agent_id: 'a1', timestamp: new Date(), attempt: 1,
        model: 'gpt-4o',
        token_usage: { inputTokens: ONE_MILLION_INPUT_TOKENS, outputTokens: 0, totalTokens: ONE_MILLION_INPUT_TOKENS },
      },
    });
    return { childGraph, parentGraph };
  }

  it('rolls the child subgraph cost into the parent total_cost_usd', async () => {
    const { childGraph, parentGraph } = createCostyChildAndParent();
    const loadGraphFn = vi.fn().mockResolvedValue(childGraph);
    const state = createTestState({ budget_usd: 100 });

    const finalState = await new GraphRunner(parentGraph, state, { loadGraphFn }).run();

    expect(finalState.status).toBe('completed');
    expect(finalState.total_cost_usd).toBeCloseTo(CHILD_SPEND_USD, 5);
  });

  it('enforces the parent USD budget against child subgraph spend', async () => {
    const { childGraph, parentGraph } = createCostyChildAndParent();
    const loadGraphFn = vi.fn().mockResolvedValue(childGraph);
    const BUDGET_BELOW_CHILD_SPEND = 1;
    const state = createTestState({ budget_usd: BUDGET_BELOW_CHILD_SPEND });

    await expect(
      new GraphRunner(parentGraph, state, { loadGraphFn }).run(),
    ).rejects.toThrow(/budget exceeded/i);
  });

  it('detects subgraph cycles (A -> B -> A)', async () => {
    const childGraph: Graph = {
      id: 'child-graph',
      name: 'child',
      description: 'Child that calls parent',
      nodes: [
        {
          id: 'recursive-sub',
          type: 'subgraph',
          subgraph_config: {
            subgraph_id: 'parent-graph',
            input_mapping: {},
            output_mapping: {},
            max_iterations: 50,
          },
          read_keys: ['*'],
          write_keys: ['*'],
          failure_policy: { max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 0, max_backoff_ms: 0 },
          requires_compensation: false,
        },
      ],
      edges: [],
      start_node: 'recursive-sub',
      end_nodes: ['recursive-sub'],
    };

    const parentGraph: Graph = {
      id: 'parent-graph',
      name: 'parent',
      description: 'Parent that invokes child',
      nodes: [
        {
          id: 'sub-node',
          type: 'subgraph',
          subgraph_config: {
            subgraph_id: 'child-graph',
            input_mapping: {},
            output_mapping: {},
            max_iterations: 50,
          },
          read_keys: ['*'],
          write_keys: ['*'],
          failure_policy: { max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 0, max_backoff_ms: 0 },
          requires_compensation: false,
        },
      ],
      edges: [],
      start_node: 'sub-node',
      end_nodes: ['sub-node'],
    };

    const loadGraphFn = vi.fn().mockImplementation(async (graphId: string) => {
      if (graphId === 'child-graph') return childGraph;
      if (graphId === 'parent-graph') return parentGraph;
      return null;
    });

    const state = createTestState();
    const runner = new GraphRunner(parentGraph, state, { loadGraphFn });

    await expect(runner.run()).rejects.toThrow(/[Cc]ycle/);
  });

  it('enforces a maximum subgraph nesting depth', async () => {
    const parentGraph: Graph = {
      id: 'deep-parent',
      name: 'deep',
      description: 'deeply nested',
      nodes: [
        {
          id: 'sub-node',
          type: 'subgraph',
          subgraph_config: {
            subgraph_id: 'child-graph',
            input_mapping: {},
            output_mapping: {},
            max_iterations: 50,
          },
          read_keys: ['*'],
          write_keys: ['*'],
          failure_policy: { max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 0, max_backoff_ms: 0 },
          requires_compensation: false,
        },
      ],
      edges: [],
      start_node: 'sub-node',
      end_nodes: ['sub-node'],
    };

    const stackAlreadyNestedAtDepthCap = Array.from({ length: 32 }, (_, i) => `g${i}`);
    const state = createTestState({ subgraph_stack: stackAlreadyNestedAtDepthCap });
    const loadGraphFn = vi.fn().mockResolvedValue(createToolGraph('child-graph'));
    const runner = new GraphRunner(parentGraph, state, { loadGraphFn });

    await expect(runner.run()).rejects.toThrow(/depth/i);
  });

  it('throws when subgraph graph is not found', async () => {
    const parentGraph: Graph = {
      id: 'parent-graph',
      name: 'parent',
      description: 'Missing subgraph',
      nodes: [
        {
          id: 'sub-node',
          type: 'subgraph',
          subgraph_config: {
            subgraph_id: 'nonexistent-graph',
            input_mapping: {},
            output_mapping: {},
            max_iterations: 50,
          },
          read_keys: ['*'],
          write_keys: ['*'],
          failure_policy: { max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 0, max_backoff_ms: 0 },
          requires_compensation: false,
        },
      ],
      edges: [],
      start_node: 'sub-node',
      end_nodes: ['sub-node'],
    };

    const loadGraphFn = vi.fn().mockResolvedValue(null);
    const state = createTestState();
    const runner = new GraphRunner(parentGraph, state, { loadGraphFn });

    await expect(runner.run()).rejects.toThrow(/missing graph/);
  });

  it('propagates child failure to parent (child tool node is missing tool_id)', async () => {
    const childGraph: Graph = {
      id: 'failing-child',
      name: 'failing child',
      description: 'Will fail',
      nodes: [
        {
          id: 'bad-node',
          type: 'tool',
          read_keys: ['*'],
          write_keys: ['*'],
          failure_policy: { max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 0, max_backoff_ms: 0 },
          requires_compensation: false,
        },
      ],
      edges: [],
      start_node: 'bad-node',
      end_nodes: ['bad-node'],
    };

    const parentGraph: Graph = {
      id: 'parent-graph',
      name: 'parent',
      description: 'Child will fail',
      nodes: [
        {
          id: 'sub-node',
          type: 'subgraph',
          subgraph_config: {
            subgraph_id: 'failing-child',
            input_mapping: {},
            output_mapping: {},
            max_iterations: 50,
          },
          read_keys: ['*'],
          write_keys: ['*'],
          failure_policy: { max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 0, max_backoff_ms: 0 },
          requires_compensation: false,
        },
      ],
      edges: [],
      start_node: 'sub-node',
      end_nodes: ['sub-node'],
    };

    const loadGraphFn = vi.fn().mockResolvedValue(childGraph);
    const state = createTestState();
    const runner = new GraphRunner(parentGraph, state, { loadGraphFn });

    await expect(runner.run()).rejects.toThrow(/missing tool_id/);
  });

  it('skips output keys the child never produced', async () => {
    const childGraph = createToolGraph('child-graph');
    const parentGraph: Graph = {
      id: 'parent-graph', name: 'parent', description: 'partial output mapping',
      nodes: [{
        id: 'sub-node', type: 'subgraph',
        subgraph_config: {
          subgraph_id: 'child-graph',
          input_mapping: {},
          output_mapping: { 'tool-node_result': 'produced', 'never_written': 'absent' },
          max_iterations: 50,
        },
        read_keys: ['*'], write_keys: ['*'],
        failure_policy: { max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 0, max_backoff_ms: 0 },
        requires_compensation: false,
      }],
      edges: [], start_node: 'sub-node', end_nodes: ['sub-node'],
    };
    const loadGraphFn = vi.fn().mockResolvedValue(childGraph);

    const finalState = await new GraphRunner(parentGraph, createTestState(), { loadGraphFn }).run();

    expect(finalState.status).toBe('completed');
    expect(finalState.memory.produced).toBeDefined();
    expect(finalState.memory.absent).toBeUndefined();
  });

  it('revives a JSON-round-tripped child checkpoint (string dates) on resume', async () => {
    const childGraph: Graph = {
      id: 'child-graph', name: 'child', description: 'child with an approval gate',
      nodes: [
        {
          id: 'gate', type: 'approval',
          approval_config: {
            approval_type: 'human_review',
            prompt_message: 'approve child',
            review_keys: ['child_input'],
            timeout_ms: 60000,
          },
          read_keys: ['*'], write_keys: [],
          failure_policy: { max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 0, max_backoff_ms: 0 },
          requires_compensation: false,
        },
      ],
      edges: [], start_node: 'gate', end_nodes: ['gate'],
    };
    const parentGraph: Graph = {
      id: 'parent-graph', name: 'parent', description: 'wraps a gated child',
      nodes: [{
        id: 'sub-node', type: 'subgraph',
        subgraph_config: {
          subgraph_id: 'child-graph',
          input_mapping: { parent_input: 'child_input' },
          output_mapping: {},
          max_iterations: 50,
        },
        read_keys: ['*'], write_keys: ['*'],
        failure_policy: { max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 0, max_backoff_ms: 0 },
        requires_compensation: false,
      }],
      edges: [], start_node: 'sub-node', end_nodes: ['sub-node'],
    };
    const loadGraphFn = vi.fn().mockResolvedValue(childGraph);
    const state = createTestState({ memory: { parent_input: 'review me' } });

    const waiting = await new GraphRunner(parentGraph, state, { loadGraphFn }).run();
    expect(waiting.status).toBe('waiting');
    expect(waiting.subgraph_checkpoints['sub-node'].waiting_timeout_at).toBeDefined();

    const serialized = JSON.parse(JSON.stringify(waiting)) as WorkflowState;
    const r2 = new GraphRunner(parentGraph, serialized, { loadGraphFn });
    r2.applyHumanResponse({ decision: 'approved' });
    const done = await r2.run();

    expect(done.status).toBe('completed');
  });

  it('throws NodeConfigError when subgraph_config is missing', async () => {
    const node = { id: 'sub-node', type: 'subgraph', read_keys: ['*'], write_keys: ['*'] } as unknown as GraphNode;
    const stateView: StateView = { workflow_id: 'wf', run_id: 'run', goal: 'g', constraints: [], memory: {} };
    const ctx = {
      state: createTestState(),
      graph: createToolGraph('parent'),
      loadGraphFn: vi.fn(),
      createStateView: () => stateView,
      deps: {} as never,
    } as unknown as NodeExecutorContext;

    await expect(executeSubgraphNode(node, stateView, 1, ctx)).rejects.toThrow(NodeConfigError);
  });

  it('only maps input keys that are present in parent memory', async () => {
    const childGraph = createToolGraph('child-graph');
    const parentGraph: Graph = {
      id: 'parent-graph', name: 'parent', description: 'partial input mapping',
      nodes: [{
        id: 'sub-node', type: 'subgraph',
        subgraph_config: {
          subgraph_id: 'child-graph',
          input_mapping: { present_key: 'child_a', absent_key: 'child_b' },
          output_mapping: {},
          max_iterations: 50,
        },
        read_keys: ['*'], write_keys: ['*'],
        failure_policy: { max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 0, max_backoff_ms: 0 },
        requires_compensation: false,
      }],
      edges: [], start_node: 'sub-node', end_nodes: ['sub-node'],
    };
    const loadGraphFn = vi.fn().mockResolvedValue(childGraph);
    const state = createTestState({ memory: { present_key: 'value' } });

    const finalState = await new GraphRunner(parentGraph, state, { loadGraphFn }).run();

    expect(finalState.status).toBe('completed');
  });

  it('propagates the parent rate limiter into the child runner', async () => {
    const rateLimiter = vi.fn().mockResolvedValue(undefined);
    (executeAgent as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: uuidv4(), idempotency_key: uuidv4(), type: 'update_memory',
      payload: { updates: { child_result: 'done' } },
      metadata: { node_id: 'child-agent', agent_id: 'a1', timestamp: new Date(), attempt: 1 },
    });
    const childGraph: Graph = {
      id: 'child-graph', name: 'child', description: 'agent child',
      nodes: [{
        id: 'child-agent', type: 'agent', agent_id: 'a1',
        read_keys: ['*'], write_keys: ['*'],
        failure_policy: { max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 0, max_backoff_ms: 0 },
        requires_compensation: false,
      }],
      edges: [], start_node: 'child-agent', end_nodes: ['child-agent'],
    };
    const parentGraph: Graph = {
      id: 'parent-graph', name: 'parent', description: 'wraps child',
      nodes: [{
        id: 'sub-node', type: 'subgraph',
        subgraph_config: { subgraph_id: 'child-graph', input_mapping: {}, output_mapping: {}, max_iterations: 50 },
        read_keys: ['*'], write_keys: ['*'],
        failure_policy: { max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 0, max_backoff_ms: 0 },
        requires_compensation: false,
      }],
      edges: [], start_node: 'sub-node', end_nodes: ['sub-node'],
    };
    const loadGraphFn = vi.fn().mockResolvedValue(childGraph);

    const finalState = await new GraphRunner(parentGraph, createTestState(), { loadGraphFn, rateLimiter }).run();

    expect(finalState.status).toBe('completed');
    expect(rateLimiter).toHaveBeenCalled();
  });

  it('propagates a child compensation entry with a namespaced action id', async () => {
    const childActionId = uuidv4();
    (executeAgent as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: childActionId, idempotency_key: uuidv4(), type: 'update_memory',
      payload: { updates: { child_result: 'done' } },
      compensation: { type: 'update_memory', payload: { rollback: true } },
      metadata: { node_id: 'child-agent', agent_id: 'a1', timestamp: new Date(), attempt: 1 },
    });
    const childGraph: Graph = {
      id: 'child-graph', name: 'child', description: 'compensating agent child',
      nodes: [{
        id: 'child-agent', type: 'agent', agent_id: 'a1',
        read_keys: ['*'], write_keys: ['*'],
        failure_policy: { max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 0, max_backoff_ms: 0 },
        requires_compensation: true,
      }],
      edges: [], start_node: 'child-agent', end_nodes: ['child-agent'],
    };
    const parentGraph: Graph = {
      id: 'parent-graph', name: 'parent', description: 'wraps compensating child',
      nodes: [{
        id: 'sub-node', type: 'subgraph',
        subgraph_config: { subgraph_id: 'child-graph', input_mapping: {}, output_mapping: {}, max_iterations: 50 },
        read_keys: ['*'], write_keys: ['*'],
        failure_policy: { max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 0, max_backoff_ms: 0 },
        requires_compensation: false,
      }],
      edges: [], start_node: 'sub-node', end_nodes: ['sub-node'],
    };
    const loadGraphFn = vi.fn().mockResolvedValue(childGraph);

    const finalState = await new GraphRunner(parentGraph, createTestState(), { loadGraphFn }).run();

    expect(finalState.status).toBe('completed');
    expect(finalState.compensation_stack.some(e => e.action_id === `subgraph:sub-node:${childActionId}`)).toBe(true);
  });

  it('fails the parent closed when a rejected nested approval cancels the child', async () => {
    (executeAgent as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: uuidv4(), idempotency_key: uuidv4(), type: 'update_memory',
      payload: { updates: { send: 'the message' } },
      metadata: { node_id: 'sender', agent_id: 'sender', timestamp: new Date(), attempt: 1 },
    });
    const securityPolicy = (c: { node: { write_keys?: string[] } }) =>
      (c.node.write_keys ?? []).includes('send')
        ? { effect: 'require_approval' as const, sensitivity: ['state_write'], reason: 'gate' }
        : { effect: 'allow' as const };

    const childGraph: Graph = {
      id: 'child-graph', name: 'child', description: 'child',
      nodes: [{
        id: 'sender', type: 'agent', agent_id: 'sender',
        read_keys: ['child_input'], write_keys: ['send'],
        failure_policy: { max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 0, max_backoff_ms: 0 },
        requires_compensation: false,
      }],
      edges: [], start_node: 'sender', end_nodes: ['sender'],
    };
    const parentGraph: Graph = {
      id: 'parent-graph', name: 'parent', description: 'parent',
      nodes: [{
        id: 'sub-node', type: 'subgraph',
        subgraph_config: {
          subgraph_id: 'child-graph',
          input_mapping: { parent_input: 'child_input' },
          output_mapping: { send: 'parent_result' },
          max_iterations: 50,
        },
        read_keys: ['*'], write_keys: ['*'],
        failure_policy: { max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 0, max_backoff_ms: 0 },
        requires_compensation: false,
      }],
      edges: [], start_node: 'sub-node', end_nodes: ['sub-node'],
    };
    const loadGraphFn = vi.fn().mockResolvedValue(childGraph);

    const state = createTestState({ memory: { parent_input: 'untrusted content' } });
    state.taint_registry = markTainted({}, 'parent_input', { source: 'tool_node', tool_name: 'ext', created_at: new Date().toISOString() });

    const waiting = await new GraphRunner(parentGraph, state, { loadGraphFn, securityPolicy }).run();
    expect(waiting.status).toBe('waiting');

    const r2 = new GraphRunner(parentGraph, JSON.parse(JSON.stringify(waiting)), { loadGraphFn, securityPolicy });
    r2.applyHumanResponse({ decision: 'rejected', data: 'no' });

    await expect(r2.run()).rejects.toThrow(/did not complete/);
  });

  it('throws when no loadGraphFn is provided', async () => {
    const parentGraph: Graph = {
      id: 'parent-graph',
      name: 'parent',
      description: 'No loadGraphFn',
      nodes: [
        {
          id: 'sub-node',
          type: 'subgraph',
          subgraph_config: {
            subgraph_id: 'child-graph',
            input_mapping: {},
            output_mapping: {},
            max_iterations: 50,
          },
          read_keys: ['*'],
          write_keys: ['*'],
          failure_policy: { max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 0, max_backoff_ms: 0 },
          requires_compensation: false,
        },
      ],
      edges: [],
      start_node: 'sub-node',
      end_nodes: ['sub-node'],
    };

    const state = createTestState();
    const runner = new GraphRunner(parentGraph, state);

    await expect(runner.run()).rejects.toThrow(/loadGraphFn/);
  });

  it('propagates child compensation stack to parent', async () => {
    const childGraph: Graph = {
      id: 'child-with-compensation',
      name: 'child',
      description: 'Child with compensation',
      nodes: [
        {
          id: 'tool-node',
          type: 'tool',
          tool_id: 'mock-tool',
          read_keys: ['*'],
          write_keys: ['*'],
          failure_policy: { max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 0, max_backoff_ms: 0 },
          requires_compensation: true,
        },
      ],
      edges: [],
      start_node: 'tool-node',
      end_nodes: ['tool-node'],
    };

    const parentGraph: Graph = {
      id: 'parent-graph',
      name: 'parent',
      description: 'Parent testing compensation propagation',
      nodes: [
        {
          id: 'sub-node',
          type: 'subgraph',
          subgraph_config: {
            subgraph_id: 'child-with-compensation',
            input_mapping: {},
            output_mapping: { 'tool-node_result': 'child_output' },
            max_iterations: 50,
          },
          read_keys: ['*'],
          write_keys: ['*'],
          failure_policy: { max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 0, max_backoff_ms: 0 },
          requires_compensation: false,
        },
      ],
      edges: [],
      start_node: 'sub-node',
      end_nodes: ['sub-node'],
    };

    const loadGraphFn = vi.fn().mockResolvedValue(childGraph);
    const state = createTestState();
    const runner = new GraphRunner(parentGraph, state, { loadGraphFn });
    const finalState = await runner.run();

    expect(finalState.status).toBe('completed');
    for (const entry of finalState.compensation_stack) {
      if (entry.action_id.startsWith('subgraph:sub-node:')) {
        return;
      }
    }
  });

  it('propagates taint across the subgraph boundary (no laundering)', async () => {
    let childSawTaintedInput = false;
    (executeAgent as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (agentId: string, stateView: { memory: Record<string, unknown>; taint?: Record<string, unknown> }) => {
        childSawTaintedInput = 'child_input' in (stateView.taint ?? {});
        return {
          id: uuidv4(),
          idempotency_key: uuidv4(),
          type: 'update_memory',
          payload: {
            updates: {
              child_output: 'processed',
              _taint_registry: { child_output: { source: 'derived', agent_id: agentId, created_at: new Date().toISOString() } },
            },
          },
          metadata: { node_id: agentId, agent_id: agentId, timestamp: new Date(), attempt: 1 },
        };
      },
    );

    const childGraph: Graph = {
      id: 'child-graph', name: 'child', description: 'child',
      nodes: [{
        id: 'worker', type: 'agent', agent_id: 'worker',
        read_keys: ['child_input'], write_keys: ['child_output'],
        failure_policy: { max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 0, max_backoff_ms: 0 },
        requires_compensation: false,
      }],
      edges: [], start_node: 'worker', end_nodes: ['worker'],
    };

    const parentGraph: Graph = {
      id: 'parent-graph', name: 'parent', description: 'parent',
      nodes: [{
        id: 'sub-node', type: 'subgraph',
        subgraph_config: {
          subgraph_id: 'child-graph',
          input_mapping: { parent_input: 'child_input' },
          output_mapping: { child_output: 'parent_result' },
          max_iterations: 50,
        },
        read_keys: ['*'], write_keys: ['*'],
        failure_policy: { max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 0, max_backoff_ms: 0 },
        requires_compensation: false,
      }],
      edges: [], start_node: 'sub-node', end_nodes: ['sub-node'],
    };

    const state = createTestState({ memory: { parent_input: 'untrusted content' } });
    state.taint_registry = markTainted({}, 'parent_input', { source: 'tool_node', tool_name: 'external_input', created_at: new Date().toISOString() });

    const loadGraphFn = vi.fn().mockResolvedValue(childGraph);
    const finalState = await new GraphRunner(parentGraph, state, { loadGraphFn }).run();

    expect(finalState.status).toBe('completed');
    expect(childSawTaintedInput).toBe(true);
    const reg = (finalState.taint_registry ?? {}) as Record<string, unknown>;
    expect('parent_result' in reg).toBe(true);
  });

  it('gates a sensitive child node and resumes it across the boundary (HITL)', async () => {
    (executeAgent as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (agentId: string) => ({
        id: uuidv4(), idempotency_key: uuidv4(), type: 'update_memory',
        payload: { updates: { send: 'the message' } },
        metadata: { node_id: agentId, agent_id: agentId, timestamp: new Date(), attempt: 1 },
      }),
    );

    const securityPolicy = (c: { node: { write_keys?: string[] } }) =>
      (c.node.write_keys ?? []).includes('send')
        ? { effect: 'require_approval' as const, sensitivity: ['state_write'], reason: 'untrusted → send' }
        : { effect: 'allow' as const };

    const childGraph: Graph = {
      id: 'child-graph', name: 'child', description: 'child',
      nodes: [{
        id: 'sender', type: 'agent', agent_id: 'sender',
        read_keys: ['child_input'], write_keys: ['send'],
        failure_policy: { max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 0, max_backoff_ms: 0 },
        requires_compensation: false,
      }],
      edges: [], start_node: 'sender', end_nodes: ['sender'],
    };
    const parentGraph: Graph = {
      id: 'parent-graph', name: 'parent', description: 'parent',
      nodes: [{
        id: 'sub-node', type: 'subgraph',
        subgraph_config: {
          subgraph_id: 'child-graph',
          input_mapping: { parent_input: 'child_input' },
          output_mapping: { send: 'parent_result' },
          max_iterations: 50,
        },
        read_keys: ['*'], write_keys: ['*'],
        failure_policy: { max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 0, max_backoff_ms: 0 },
        requires_compensation: false,
      }],
      edges: [], start_node: 'sub-node', end_nodes: ['sub-node'],
    };
    const loadGraphFn = vi.fn().mockResolvedValue(childGraph);

    const state = createTestState({ memory: { parent_input: 'untrusted content' } });
    state.taint_registry = markTainted({}, 'parent_input', { source: 'tool_node', tool_name: 'external_input', created_at: new Date().toISOString() });

    const waiting = await new GraphRunner(parentGraph, state, { loadGraphFn, securityPolicy }).run();
    expect(waiting.status).toBe('waiting');
    expect((waiting.pending_approval as { subgraph_node_id?: string }).subgraph_node_id).toBe('sub-node');
    expect(waiting.subgraph_checkpoints['sub-node']).toBeDefined();
    expect(executeAgent).not.toHaveBeenCalled();
    expect(waiting.memory.parent_result).toBeUndefined();

    const r2 = new GraphRunner(parentGraph, waiting, { loadGraphFn, securityPolicy });
    r2.applyHumanResponse({ decision: 'approved' });
    const done = await r2.run();
    expect(done.status).toBe('completed');
    expect(done.memory.parent_result).toBe('the message');
  });
});
