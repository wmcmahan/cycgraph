import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeSynthesizerNode } from '../src/runner/node-executors/synthesizer.js';
import type { GraphNode } from '../src/types/graph.js';
import type { WorkflowState, StateView, Action } from '../src/types/state.js';
import type { NodeExecutorContext, ExecutorDependencies } from '../src/runner/node-executors/context.js';

// Mock logger
vi.mock('../src/utils/logger.js', () => ({
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
    id: 'synth-1',
    type: 'synthesizer',
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
    current_node: 'synth-1',
    iteration_count: 3,
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

function makeStateView(memory: Record<string, unknown> = {}): StateView {
  return {
    workflow_id: 'wf-1',
    run_id: 'run-1',
    goal: 'Test goal',
    constraints: [],
    memory,
  };
}

function makeMockAction(): Action {
  return {
    id: 'act-1',
    idempotency_key: 'idem-1',
    type: 'update_memory',
    payload: { updates: { synthesis: 'AI-generated synthesis' } },
    metadata: { node_id: 'synth-1', timestamp: new Date(), attempt: 1 },
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
    graph: { id: 'g-1', name: 'Test', nodes: [], edges: [], start_node: 'start', metadata: {} } as any,
    createStateView: () => makeStateView(),
    deps: makeDeps(),
    ...overrides,
  };
}

// ─── Simple Merge Path ────────────────────────────────────────────────

describe('executeSynthesizerNode (simple merge)', () => {
  it('concatenates all *_results arrays from memory', async () => {
    const stateView = makeStateView({
      research_results: ['fact1', 'fact2'],
      analysis_results: ['insight1'],
    });
    const ctx = makeCtx();

    const result = await executeSynthesizerNode(makeNode(), stateView, 1, ctx);

    expect(result.type).toBe('update_memory');
    const synthesis = (result.payload.updates as Record<string, unknown>)['synth-1_synthesis'];
    expect(synthesis).toEqual(['fact1', 'fact2', 'insight1']);
  });

  it('returns empty array when no *_results keys exist', async () => {
    const stateView = makeStateView({ other_key: 'value' });
    const ctx = makeCtx();

    const result = await executeSynthesizerNode(makeNode(), stateView, 1, ctx);

    const synthesis = (result.payload.updates as Record<string, unknown>)['synth-1_synthesis'];
    expect(synthesis).toEqual([]);
  });

  it('ignores non-array *_results values', async () => {
    const stateView = makeStateView({
      valid_results: ['item1'],
      broken_results: 'not an array',
    });
    const ctx = makeCtx();

    const result = await executeSynthesizerNode(makeNode(), stateView, 1, ctx);

    const synthesis = (result.payload.updates as Record<string, unknown>)['synth-1_synthesis'];
    expect(synthesis).toEqual(['item1']);
  });

  it('includes correct metadata', async () => {
    const ctx = makeCtx();

    const result = await executeSynthesizerNode(makeNode(), makeStateView(), 2, ctx);

    expect(result.metadata.node_id).toBe('synth-1');
    expect(result.metadata.attempt).toBe(2);
  });

  it('generates correct idempotency key', async () => {
    const ctx = makeCtx();

    const result = await executeSynthesizerNode(makeNode(), makeStateView(), 1, ctx);

    expect(result.idempotency_key).toBe('synth-1:3:1'); // node_id:iteration:attempt
  });
});

// ─── Agent-Powered Synthesis ──────────────────────────────────────────

describe('executeSynthesizerNode (agent-powered)', () => {
  it('delegates to executeAgent when agent_id is set', async () => {
    const deps = makeDeps();
    const ctx = makeCtx({ deps });
    const node = makeNode({ agent_id: 'synthesizer-agent' });

    const result = await executeSynthesizerNode(node, makeStateView(), 1, ctx);

    expect(deps.executeAgent).toHaveBeenCalledWith(
      'synthesizer-agent',
      expect.any(Object),
      expect.any(Object),
      1,
      expect.objectContaining({ nodeId: 'synth-1' }),
    );
    expect(result.type).toBe('update_memory');
  });

  it('loads agent config and tools before execution', async () => {
    const deps = makeDeps();
    const ctx = makeCtx({ deps });
    const node = makeNode({ agent_id: 'synthesizer-agent' });

    await executeSynthesizerNode(node, makeStateView(), 1, ctx);

    expect(deps.loadAgent).toHaveBeenCalledWith('synthesizer-agent');
    expect(deps.resolveTools).toHaveBeenCalled();
  });

  it('propagates errors from agent execution', async () => {
    const deps = makeDeps({
      executeAgent: vi.fn().mockRejectedValue(new Error('Agent failed')),
    });
    const ctx = makeCtx({ deps });
    const node = makeNode({ agent_id: 'synthesizer-agent' });

    await expect(
      executeSynthesizerNode(node, makeStateView(), 1, ctx),
    ).rejects.toThrow('Agent failed');
  });

  it('passes onToken callback when available', async () => {
    const onToken = vi.fn();
    const deps = makeDeps();
    const ctx = makeCtx({ deps, onToken });
    const node = makeNode({ agent_id: 'synthesizer-agent' });

    await executeSynthesizerNode(node, makeStateView(), 1, ctx);

    const callArgs = (deps.executeAgent as any).mock.calls[0][4];
    expect(callArgs.onToken).toBeDefined();
  });
});
