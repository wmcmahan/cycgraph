/**
 * Integration tests for budget-aware model resolution.
 *
 * Tests the full wiring: agent node executor → model resolver → executeAgent model_override.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeAgentNode } from '../src/runner/node-executors/agent.js';
import { executeSupervisorNode } from '../src/runner/node-executors/supervisor.js';
import { defaultModelResolver } from '../src/agent/model-resolver.js';
import type { ModelResolver, ModelTierMap, ModelResolutionResult } from '../src/agent/model-resolver.js';
import type { GraphNode, Graph } from '../src/types/graph.js';
import type { WorkflowState, StateView, Action } from '../src/types/state.js';
import type { NodeExecutorContext, ExecutorDependencies } from '../src/runner/node-executors/context.js';

// Mock logger (vi.hoisted ensures the fn is available before vi.mock runs)
const { warnFn } = vi.hoisted(() => ({ warnFn: vi.fn() }));
vi.mock('../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: warnFn,
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// ─── Shared Fixtures ──────────────────────────────────────────────

const TIER_MAP: ModelTierMap = {
  high:   { anthropic: 'claude-opus-4-8',    openai: 'o3' },
  medium: { anthropic: 'claude-sonnet-4-6',  openai: 'gpt-4o' },
  low:    { anthropic: 'claude-haiku-4-5-20251001', openai: 'gpt-4o-mini' },
};

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

function makeState(overrides: Partial<WorkflowState> = {}): WorkflowState {
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
    ...overrides,
  };
}

function makeStateView(): StateView {
  return {
    workflow_id: 'wf-1',
    run_id: 'run-1',
    goal: 'Test goal',
    constraints: [],
    memory: {},
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
    executeSupervisor: vi.fn().mockResolvedValue(makeMockAction()),
    evaluateQualityExecutor: vi.fn(),
    resolveTools: vi.fn().mockResolvedValue({}),
    loadAgent: vi.fn().mockResolvedValue({
      tools: [],
      write_keys: [],
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
    }),
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

// ─── Agent Node: Model Resolution ─────────────────────────────────

describe('executeAgentNode — model resolution', () => {
  beforeEach(() => {
    warnFn.mockClear();
  });

  it('passes model_override when resolver returns a result', async () => {
    const deps = makeDeps({
      loadAgent: vi.fn().mockResolvedValue({
        tools: [],
        write_keys: [],
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        model_preference: 'high',
      }),
    });
    const resolver = defaultModelResolver(TIER_MAP);
    const node = makeNode({ agent_id: 'agent-1' });
    const ctx = makeCtx({
      deps,
      modelResolver: resolver,
      remainingBudgetUsd: 100, // plenty of headroom
    });

    await executeAgentNode(node, makeStateView(), 1, ctx);

    // Should have called executeAgent with model_override set to the high-tier model
    expect(deps.executeAgent).toHaveBeenCalledWith(
      'agent-1',
      expect.any(Object),
      expect.any(Object),
      1,
      expect.objectContaining({
        model_override: 'claude-opus-4-8',
      }),
    );
  });

  it('does NOT pass model_override when agent has no model_preference', async () => {
    const deps = makeDeps({
      loadAgent: vi.fn().mockResolvedValue({
        tools: [],
        write_keys: [],
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        // no model_preference
      }),
    });
    const resolver = defaultModelResolver(TIER_MAP);
    const node = makeNode({ agent_id: 'agent-1' });
    const ctx = makeCtx({
      deps,
      modelResolver: resolver,
      remainingBudgetUsd: 100,
    });

    await executeAgentNode(node, makeStateView(), 1, ctx);

    // Should NOT have model_override in options
    const callArgs = (deps.executeAgent as ReturnType<typeof vi.fn>).mock.calls[0][4];
    expect(callArgs.model_override).toBeUndefined();
  });

  it('does NOT pass model_override when no resolver is configured', async () => {
    const deps = makeDeps({
      loadAgent: vi.fn().mockResolvedValue({
        tools: [],
        write_keys: [],
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        model_preference: 'high',
      }),
    });
    const node = makeNode({ agent_id: 'agent-1' });
    const ctx = makeCtx({
      deps,
      // no modelResolver
    });

    await executeAgentNode(node, makeStateView(), 1, ctx);

    const callArgs = (deps.executeAgent as ReturnType<typeof vi.fn>).mock.calls[0][4];
    expect(callArgs.model_override).toBeUndefined();
  });

  it('logs a warning when model_preference is set but no resolver configured', async () => {
    const deps = makeDeps({
      loadAgent: vi.fn().mockResolvedValue({
        tools: [],
        write_keys: [],
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        model_preference: 'high',
      }),
    });
    const node = makeNode({ agent_id: 'agent-1' });
    const ctx = makeCtx({ deps });

    await executeAgentNode(node, makeStateView(), 1, ctx);

    expect(warnFn).toHaveBeenCalledWith('model_preference_no_resolver', expect.objectContaining({
      agent_id: 'agent-1',
      preference: 'high',
    }));
  });

  it('downgrades model when budget is tight', async () => {
    const deps = makeDeps({
      loadAgent: vi.fn().mockResolvedValue({
        tools: [],
        write_keys: [],
        provider: 'anthropic',
        model: 'claude-opus-4-8',
        model_preference: 'high',
      }),
    });
    const resolver = defaultModelResolver(TIER_MAP);
    const node = makeNode({ agent_id: 'agent-1' });
    const ctx = makeCtx({
      deps,
      modelResolver: resolver,
      remainingBudgetUsd: 0.001, // very tight budget
    });

    await executeAgentNode(node, makeStateView(), 1, ctx);

    const callArgs = (deps.executeAgent as ReturnType<typeof vi.fn>).mock.calls[0][4];
    // Should have been downgraded from opus to sonnet or haiku
    expect(callArgs.model_override).toBeDefined();
    expect(callArgs.model_override).not.toBe('claude-opus-4-8');
  });

  it('fires onModelResolved callback when resolution occurs', async () => {
    const deps = makeDeps({
      loadAgent: vi.fn().mockResolvedValue({
        tools: [],
        write_keys: [],
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        model_preference: 'medium',
      }),
    });
    const onModelResolved = vi.fn();
    const resolver = defaultModelResolver(TIER_MAP);
    const node = makeNode({ agent_id: 'agent-1' });
    const ctx = makeCtx({
      deps,
      modelResolver: resolver,
      remainingBudgetUsd: 100,
      onModelResolved,
    });

    await executeAgentNode(node, makeStateView(), 1, ctx);

    expect(onModelResolved).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-1',
        originalModel: 'claude-sonnet-4-6',
        resolution: expect.objectContaining({
          reason: 'preferred',
          model: 'claude-sonnet-4-6',
        }),
      }),
      'node-1',
    );
  });

  it('handles resolver returning null (unknown provider) gracefully', async () => {
    const deps = makeDeps({
      loadAgent: vi.fn().mockResolvedValue({
        tools: [],
        write_keys: [],
        provider: 'unknown-provider',
        model: 'some-model',
        model_preference: 'high',
      }),
    });
    const resolver = defaultModelResolver(TIER_MAP);
    const node = makeNode({ agent_id: 'agent-1' });
    const ctx = makeCtx({
      deps,
      modelResolver: resolver,
      remainingBudgetUsd: 100,
    });

    await executeAgentNode(node, makeStateView(), 1, ctx);

    // resolver returns null → no override → falls back to config.model
    const callArgs = (deps.executeAgent as ReturnType<typeof vi.fn>).mock.calls[0][4];
    expect(callArgs.model_override).toBeUndefined();
  });

  it('security: agent cannot influence resolution via memory writes', async () => {
    // Even if the agent writes to memory._model_resolution or memory.budget_usd,
    // the resolver reads from ctx.remainingBudgetUsd (top-level WorkflowState),
    // not from memory
    const stateWithPoisonedMemory = makeState({
      memory: {
        _model_resolution: 'hacked',
        budget_usd: 999999,
      },
      budget_usd: 1.0,
      total_cost_usd: 0.99,
    });

    const deps = makeDeps({
      loadAgent: vi.fn().mockResolvedValue({
        tools: [],
        write_keys: [],
        provider: 'anthropic',
        model: 'claude-opus-4-8',
        model_preference: 'high',
      }),
    });
    const resolver = defaultModelResolver(TIER_MAP);
    const node = makeNode({ agent_id: 'agent-1' });
    const ctx = makeCtx({
      state: stateWithPoisonedMemory,
      deps,
      modelResolver: resolver,
      remainingBudgetUsd: 0.01, // computed from top-level state, not memory
    });

    await executeAgentNode(node, makeStateView(), 1, ctx);

    // Should downgrade due to tight budget (0.01 remaining),
    // regardless of memory.budget_usd value
    const callArgs = (deps.executeAgent as ReturnType<typeof vi.fn>).mock.calls[0][4];
    expect(callArgs.model_override).toBeDefined();
    expect(callArgs.model_override).not.toBe('claude-opus-4-8');
  });
});

// ─── Supervisor Node: Model Resolution ────────────────────────────

describe('executeSupervisorNode — model resolution', () => {
  it('passes model_override to executeSupervisor when resolver fires', async () => {
    const deps = makeDeps({
      loadAgent: vi.fn().mockResolvedValue({
        tools: [],
        write_keys: [],
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        model_preference: 'medium',
      }),
    });
    const resolver = defaultModelResolver(TIER_MAP);
    const node = makeNode({
      type: 'supervisor',
      agent_id: 'supervisor-agent',
      supervisor_config: {
        managed_nodes: ['worker-1', 'worker-2'],
        max_iterations: 10,
      },
    });
    const ctx = makeCtx({
      deps,
      modelResolver: resolver,
      remainingBudgetUsd: 100,
    });

    await executeSupervisorNode(node, makeStateView(), 1, ctx);

    expect(deps.executeSupervisor).toHaveBeenCalledWith(
      node,
      expect.any(Object),
      expect.any(Array),
      1,
      expect.objectContaining({
        model_override: 'claude-sonnet-4-6',
      }),
    );
  });

  it('does NOT pass model_override when supervisor has no model_preference', async () => {
    const deps = makeDeps({
      loadAgent: vi.fn().mockResolvedValue({
        tools: [],
        write_keys: [],
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        // no model_preference
      }),
    });
    const resolver = defaultModelResolver(TIER_MAP);
    const node = makeNode({
      type: 'supervisor',
      agent_id: 'supervisor-agent',
      supervisor_config: {
        managed_nodes: ['worker-1'],
        max_iterations: 10,
      },
    });
    const ctx = makeCtx({
      deps,
      modelResolver: resolver,
      remainingBudgetUsd: 100,
    });

    await executeSupervisorNode(node, makeStateView(), 1, ctx);

    const callArgs = (deps.executeSupervisor as ReturnType<typeof vi.fn>).mock.calls[0][4];
    expect(callArgs.model_override).toBeUndefined();
  });
});
