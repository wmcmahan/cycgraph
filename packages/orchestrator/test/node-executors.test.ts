import { describe, it, expect, vi } from 'vitest';
import { executeAgentNode } from '../src/execution/nodes/agent.js';
import { executeToolNode } from '../src/execution/nodes/tool.js';
import { executeApprovalNode } from '../src/execution/nodes/approval.js';
import { executeRouterNode } from '../src/execution/nodes/router.js';
import { executeSupervisorNode } from '../src/execution/nodes/supervisor.js';
import { NodeConfigError } from '../src/execution/errors.js';
import type { GraphNode, Graph } from '../src/graph/graph.js';
import type { WorkflowState, StateView, Action } from '../src/state/state.js';
import type { NodeExecutorContext, ExecutorDependencies } from '../src/execution/nodes/context.js';

// Mock logger
vi.mock('../src/observability/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// ─── Fixtures ─────────────────────────────────────────────────────────

function makeNode(overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    id: 'node-1',
    type: 'agent',
    read_keys: ['*'],
    write_keys: ['*'],
    failure_policy: {
      max_retries: 3,
      backoff_strategy: 'exponential',
      initial_backoff_ms: 1000,
      max_backoff_ms: 60000,
    },
    requires_compensation: false,
    ...overrides,
  } as GraphNode;
}

function makeState(): WorkflowState {
  return {
    workflow_id: 'wf-1',
    run_id: 'run-1',
    created_at: new Date(),
    updated_at: new Date(),
    goal: 'Test goal',
    constraints: [],
    status: 'running',
    current_node: 'node-1',
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
  };
}

function makeStateView(): StateView {
  return {
    workflow_id: 'wf-1',
    run_id: 'run-1',
    goal: 'Test goal',
    constraints: [],
    memory: { key: 'value' },
  };
}

function makeGraph(): Graph {
  return {
    id: 'graph-1',
    name: 'Test Graph',
    nodes: [makeNode()],
    edges: [],
    start_node: 'node-1',
    metadata: {},
  } as Graph;
}

function makeMockAction(): Action {
  return {
    id: 'act-1',
    idempotency_key: 'idem-1',
    type: 'update_memory',
    payload: { updates: { result: 'done' } },
    metadata: { node_id: 'node-1', timestamp: new Date(), attempt: 1 },
  };
}

function makeDeps(overrides: Partial<ExecutorDependencies> = {}): ExecutorDependencies {
  return {
    executeAgent: vi.fn().mockResolvedValue(makeMockAction()),
    executeSupervisor: vi.fn(),
    evaluateQualityExecutor: vi.fn(),
  resolveTools: vi.fn().mockResolvedValue({}),
    loadAgent: vi.fn().mockResolvedValue({ tools: [] }),
    getTaintRegistry: vi.fn().mockReturnValue({}),
    ...overrides,
  };
}

function makeCtx(overrides: Partial<NodeExecutorContext> = {}): NodeExecutorContext {
  return {
    state: makeState(),
    graph: makeGraph(),
    createStateView: () => makeStateView(),
    deps: makeDeps(),
    ...overrides,
  };
}

// ─── executeAgentNode ────────────────────────────────────────────────

describe('executeAgentNode', () => {
  it('throws NodeConfigError when agent_id is missing', async () => {
    const node = makeNode({ agent_id: undefined });
    const ctx = makeCtx();

    await expect(executeAgentNode(node, makeStateView(), 1, ctx))
      .rejects.toThrow(NodeConfigError);
  });

  it('delegates to executeAgent for standard agent nodes', async () => {
    const deps = makeDeps();
    const node = makeNode({ agent_id: 'agent-1' });
    const ctx = makeCtx({ deps });

    const result = await executeAgentNode(node, makeStateView(), 1, ctx);

    expect(deps.executeAgent).toHaveBeenCalledWith(
      'agent-1',
      expect.any(Object),
      expect.any(Object),
      1,
      expect.objectContaining({ nodeId: 'node-1' }),
    );
    expect(result.type).toBe('update_memory');
  });

  it('loads agent config and tools before execution', async () => {
    const deps = makeDeps();
    const node = makeNode({ agent_id: 'agent-1' });
    const ctx = makeCtx({ deps });

    await executeAgentNode(node, makeStateView(), 1, ctx);

    expect(deps.loadAgent).toHaveBeenCalledWith('agent-1');
    expect(deps.resolveTools).toHaveBeenCalled();
  });
});

// ─── executeToolNode ─────────────────────────────────────────────────

describe('executeToolNode', () => {
  it('throws NodeConfigError when tool_id is missing', async () => {
    const node = makeNode({ type: 'tool', tool_id: undefined });
    const ctx = makeCtx();

    await expect(executeToolNode(node, makeStateView(), 1, ctx))
      .rejects.toThrow(NodeConfigError);
  });

  it('returns update_memory action with tool result', async () => {
    const mockExecute = vi.fn().mockResolvedValue({ data: 'tool_result' });
    const deps = makeDeps({
      resolveTools: vi.fn().mockResolvedValue({
        'my-tool': { description: 'test', parameters: {}, execute: mockExecute },
      }),
    });
    const node = makeNode({ type: 'tool', tool_id: 'my-tool', tools: [] } as any);
    const ctx = makeCtx({ deps });

    const result = await executeToolNode(node, makeStateView(), 1, ctx);

    expect(result.type).toBe('update_memory');
    expect((result.payload.updates as Record<string, unknown>)['node-1_result']).toEqual({ data: 'tool_result' });
  });

  it('calls execute on the resolved tool', async () => {
    const mockExecute = vi.fn().mockResolvedValue({ data: 'tool_result' });
    const deps = makeDeps({
      resolveTools: vi.fn().mockResolvedValue({
        'my-tool': { description: 'test', parameters: {}, execute: mockExecute },
      }),
    });
    const node = makeNode({ type: 'tool', tool_id: 'my-tool', agent_id: 'agent-1', tools: [] } as any);
    const ctx = makeCtx({ deps });

    await executeToolNode(node, makeStateView(), 1, ctx);

    expect(mockExecute).toHaveBeenCalledWith(expect.any(Object));
    expect(deps.resolveTools).toHaveBeenCalledWith([], 'agent-1');
  });

  it('throws NodeConfigError when tool cannot be resolved', async () => {
    const deps = makeDeps({
      resolveTools: vi.fn().mockResolvedValue({}),
    });
    const node = makeNode({ type: 'tool', tool_id: 'missing-tool', tools: [] } as any);
    const ctx = makeCtx({ deps });

    await expect(executeToolNode(node, makeStateView(), 1, ctx))
      .rejects.toThrow(NodeConfigError);
  });
});

// ─── executeApprovalNode ─────────────────────────────────────────────

describe('executeApprovalNode', () => {
  it('throws NodeConfigError when approval_config is missing', async () => {
    const node = makeNode({ type: 'approval' });
    const ctx = makeCtx();

    await expect(executeApprovalNode(node, makeStateView(), 1, ctx))
      .rejects.toThrow(NodeConfigError);
  });

  it('returns request_human_input action with review data', async () => {
    const node = makeNode({
      type: 'approval',
      approval_config: {
        approval_type: 'review',
        review_keys: ['key'],
        prompt_message: 'Please review',
        timeout_ms: 60000,
      },
    });
    const ctx = makeCtx();

    const result = await executeApprovalNode(node, makeStateView(), 1, ctx);

    expect(result.type).toBe('request_human_input');
    expect(result.payload.waiting_for).toBe('human_approval');
    expect((result.payload.pending_approval as any).prompt_message).toBe('Please review');
  });

  it('filters memory to review_keys only', async () => {
    const stateView = { ...makeStateView(), memory: { secret: 'hidden', allowed: 'visible' } };
    const node = makeNode({
      type: 'approval',
      approval_config: {
        approval_type: 'review',
        review_keys: ['allowed'],
        prompt_message: 'Review',
      },
    });
    const ctx = makeCtx();

    const result = await executeApprovalNode(node, stateView, 1, ctx);

    const reviewData = (result.payload.pending_approval as any).review_data;
    expect(reviewData.allowed).toBe('visible');
    expect(reviewData.secret).toBeUndefined();
  });

  it('omits a review_key that is absent from memory', async () => {
    const stateView = { ...makeStateView(), memory: { present: 'here' } };
    const node = makeNode({
      type: 'approval',
      approval_config: {
        approval_type: 'review',
        review_keys: ['present', 'missing'],
        prompt_message: 'Review',
      },
    });
    const ctx = makeCtx();

    const result = await executeApprovalNode(node, stateView, 1, ctx);

    const reviewData = (result.payload.pending_approval as any).review_data;
    expect(reviewData).toEqual({ present: 'here' });
  });

  it('copies all memory when review_keys contains the wildcard', async () => {
    const stateView = { ...makeStateView(), memory: { a: 1, b: 2 } };
    const node = makeNode({
      type: 'approval',
      approval_config: {
        approval_type: 'review',
        review_keys: ['*'],
        prompt_message: 'Review',
      },
    });
    const ctx = makeCtx();

    const result = await executeApprovalNode(node, stateView, 1, ctx);

    expect((result.payload.pending_approval as any).review_data).toEqual({ a: 1, b: 2 });
  });
});

// ─── executeSupervisorNode ───────────────────────────────────────────

describe('executeSupervisorNode', () => {
  function makeHandoff(): Action {
    return {
      id: 'sup-act',
      idempotency_key: 'sup-idem',
      type: 'handoff',
      payload: { node_id: 'worker', supervisor_id: 'node-1', reasoning: 'go' },
      metadata: { node_id: 'node-1', timestamp: new Date(), attempt: 1 },
    };
  }

  it('loads the supervisor agent config and delegates to executeSupervisor', async () => {
    const executeSupervisor = vi.fn().mockResolvedValue(makeHandoff());
    const loadAgent = vi.fn().mockResolvedValue({ tools: [], provider: 'anthropic', model: 'claude-sonnet-4-6' });
    const deps = makeDeps({ executeSupervisor, loadAgent });
    const node = makeNode({
      type: 'supervisor',
      agent_id: 'sup-agent',
      supervisor_config: { managed_nodes: ['worker'], max_iterations: 5 },
    });

    const result = await executeSupervisorNode(node, makeStateView(), 1, makeCtx({ deps }));

    expect(loadAgent).toHaveBeenCalledWith('sup-agent');
    expect(executeSupervisor).toHaveBeenCalledTimes(1);
    expect(result.type).toBe('handoff');
  });

  it('forwards a budget-resolved model override to executeSupervisor', async () => {
    const executeSupervisor = vi.fn().mockResolvedValue(makeHandoff());
    const loadAgent = vi.fn().mockResolvedValue({
      tools: [], provider: 'anthropic', model: 'claude-opus-4', model_preference: 'economy',
    });
    const deps = makeDeps({ executeSupervisor, loadAgent });
    const modelResolver = vi.fn().mockReturnValue({ model: 'claude-haiku-4', reason: 'budget' });
    const node = makeNode({
      type: 'supervisor',
      agent_id: 'sup-agent',
      supervisor_config: { managed_nodes: ['worker'], max_iterations: 5 },
    });

    await executeSupervisorNode(node, makeStateView(), 1, makeCtx({ deps, modelResolver }));

    expect(executeSupervisor.mock.calls[0][4]).toMatchObject({ modelOverride: 'claude-haiku-4' });
  });

  it('skips model resolution when no agent_id is resolvable', async () => {
    const executeSupervisor = vi.fn().mockResolvedValue(makeHandoff());
    const loadAgent = vi.fn();
    const deps = makeDeps({ executeSupervisor, loadAgent });
    const node = makeNode({
      type: 'supervisor',
      agent_id: undefined,
      supervisor_config: { managed_nodes: ['worker'], max_iterations: 5 },
    });

    await executeSupervisorNode(node, makeStateView(), 1, makeCtx({ deps }));

    expect(loadAgent).not.toHaveBeenCalled();
    expect(executeSupervisor).toHaveBeenCalledTimes(1);
  });
});

// ─── executeRouterNode ───────────────────────────────────────────────

describe('executeRouterNode', () => {
  it('returns no-op update_memory action with empty updates', async () => {
    const node = makeNode({ type: 'router' });
    const ctx = makeCtx();

    const result = await executeRouterNode(node, makeStateView(), 1, ctx);

    expect(result.type).toBe('update_memory');
    expect(result.payload.updates).toEqual({});
  });

  it('includes correct metadata', async () => {
    const node = makeNode({ type: 'router' });
    const ctx = makeCtx();

    const result = await executeRouterNode(node, makeStateView(), 2, ctx);

    expect(result.metadata.node_id).toBe('node-1');
    expect(result.metadata.attempt).toBe(2);
  });
});
