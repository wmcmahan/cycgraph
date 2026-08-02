/**
 * taint-hardening.test.ts
 *
 * Phase 2 security fixes for the taint subsystem:
 *  - H1: standalone tool nodes taint their MCP output (drain from the
 *        per-resolution collector).
 *  - race: concurrent resolveTools()/drain() cycles don't cross-attribute
 *        taint (per-toolset WeakMap collector).
 *  - M5: a crafted update_memory cannot clear _taint_registry (reducer
 *        merges it append-only).
 */
import { describe, it, expect, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';

vi.mock('../src/utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { updateMemoryReducer, mergeParallelResultsReducer, handoffReducer } from '../src/reducers/index.js';
import { executeToolNode } from '../src/runner/node-executors/tool.js';
import { MCPConnectionManager } from '../src/mcp/connection-manager.js';
import { InMemoryMCPServerRegistry } from '../src/persistence/in-memory.js';
import type { Action, WorkflowState } from '../src/types/state.js';
import type { GraphNode } from '../src/types/graph.js';
import type { NodeExecutorContext } from '../src/runner/node-executors/context.js';

function makeAction(updates: Record<string, unknown>, type: Action['type'] = 'update_memory'): Action {
  return {
    id: uuidv4(),
    idempotency_key: uuidv4(),
    type,
    payload: type === 'merge_parallel_results' ? { updates } : { updates },
    metadata: { node_id: 'n', timestamp: new Date(), attempt: 1 },
  };
}

function baseState(memory: Record<string, unknown>, taint?: Record<string, unknown>): WorkflowState {
  return {
    state_schema_version: 2,
    taint_registry: taint ?? {},
    workflow_id: uuidv4(),
    run_id: uuidv4(),
    created_at: new Date(),
    updated_at: new Date(),
    goal: 'g',
    constraints: [],
    status: 'running',
    iteration_count: 0,
    retry_count: 0,
    max_retries: 3,
    memory,
    visited_nodes: [],
    max_iterations: 50,
    compensation_stack: [],
    max_execution_time_ms: 30000,
    supervisor_history: [],
    total_tokens_used: 0,
    total_cost_usd: 0,
    _cost_alert_thresholds_fired: [],
    memory_drops: [],
  } as WorkflowState;
}

// ─── M5: taint registry is append-only through reducers ─────────────────

describe('M5: _taint_registry cannot be cleared via update_memory', () => {
  const existingTaint = {
    page: { source: 'mcp_tool', tool_name: 'fetch', server_id: 'web', created_at: '2026-01-01T00:00:00Z' },
  };

  it('a crafted empty _taint_registry preserves existing entries', () => {
    const state = baseState({ page: 'attacker text' }, existingTaint);
    const next = updateMemoryReducer(state, makeAction({ _taint_registry: {} }));
    expect(next.taint_registry).toEqual(existingTaint);
  });

  it('overwriting a specific key to remove its taint is ignored (merge keeps it)', () => {
    const state = baseState({ page: 'x' }, existingTaint);
    const next = updateMemoryReducer(state, makeAction({
      _taint_registry: { other: { source: 'derived', created_at: '2026-01-02T00:00:00Z' } },
    }));
    const reg = next.taint_registry as Record<string, unknown>;
    expect(reg.page).toEqual(existingTaint.page);
    expect(reg.other).toBeDefined();
  });

  it('legitimate additive taint writes still work', () => {
    const state = baseState({}, existingTaint);
    const next = updateMemoryReducer(state, makeAction({
      _taint_registry: { ...existingTaint, doc: { source: 'mcp_tool', tool_name: 'search', server_id: 'web', created_at: '2026-01-03T00:00:00Z' } },
    }));
    const reg = next.taint_registry as Record<string, unknown>;
    expect(Object.keys(reg).sort()).toEqual(['doc', 'page']);
  });

  it('merge_parallel_results is also append-only for taint', () => {
    const state = baseState({}, existingTaint);
    const next = mergeParallelResultsReducer(
      state,
      makeAction({ _taint_registry: {} }, 'merge_parallel_results'),
    );
    expect(next.taint_registry).toEqual(existingTaint);
  });
});

// ─── H1 + race: tool-node taint via per-resolution collector ────────────

describe('H1: standalone tool nodes taint MCP output', () => {
  it('drains taint from the resolution collector and marks the result key', async () => {
    const accumulated = new Map([
      ['web:fetch', { source: 'mcp_tool' as const, tool_name: 'fetch', server_id: 'web', created_at: '2026-01-01T00:00:00Z' }],
    ]);
    const resolvedTools = { fetch: { execute: async () => 'EXTERNAL PAGE CONTENT' } };

    const ctx = {
      state: baseState({}),
      graph: { id: 'g' },
      deps: {
        resolveTools: vi.fn().mockResolvedValue(resolvedTools),
        drainTaintEntries: vi.fn((t?: unknown) => (t === resolvedTools ? accumulated : new Map())),
      },
    } as unknown as NodeExecutorContext;

    const node = {
      id: 'tool-node',
      type: 'tool',
      tool_id: 'fetch',
      tools: [{ type: 'mcp', server_id: 'web' }],
      read_keys: ['*'],
      write_keys: ['*'],
      failure_policy: { max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 1, max_backoff_ms: 1 },
    } as unknown as GraphNode;

    const action = await executeToolNode(node, { workflow_id: 'g', run_id: 'r', goal: 'x', constraints: [], memory: {} }, 1, ctx);

    const updates = (action.payload as { updates: Record<string, unknown> }).updates;
    expect(updates['tool-node_result']).toBe('EXTERNAL PAGE CONTENT');
    const reg = updates['_taint_registry'] as Record<string, unknown>;
    expect(reg).toBeDefined();
    expect((reg['tool-node_result'] as { source: string }).source).toBe('mcp_tool');
    expect(ctx.deps.drainTaintEntries).toHaveBeenCalledWith(resolvedTools);
  });

  it('no taint entries → result written untainted (no false positives)', async () => {
    const resolvedTools = { calc: { execute: async () => 42 } };
    const ctx = {
      state: baseState({}),
      graph: { id: 'g' },
      deps: {
        resolveTools: vi.fn().mockResolvedValue(resolvedTools),
        drainTaintEntries: vi.fn(() => new Map()),
      },
    } as unknown as NodeExecutorContext;

    const node = {
      id: 'calc-node', type: 'tool', tool_id: 'calc',
      tools: [{ type: 'builtin', name: 'calc' }],
      read_keys: ['*'], write_keys: ['*'],
      failure_policy: { max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 1, max_backoff_ms: 1 },
    } as unknown as GraphNode;

    const action = await executeToolNode(node, { workflow_id: 'g', run_id: 'r', goal: 'x', constraints: [], memory: {} }, 1, ctx);
    const updates = (action.payload as { updates: Record<string, unknown> }).updates;
    expect(updates['calc-node_result']).toBe(42);
    expect(updates['_taint_registry']).toBeUndefined();
  });
});

// ─── race: per-toolset collectors are isolated ──────────────────────────

describe('race: drainTaintEntries(tools) isolates concurrent resolutions', () => {
  it('two toolsets drain independently', async () => {
    const registry = new InMemoryMCPServerRegistry();
    const manager = new MCPConnectionManager(registry);
    const toolsetA = await manager.resolveTools([]);
    const toolsetB = await manager.resolveTools([]);
    expect(toolsetA).not.toBe(toolsetB);
    const drainA = manager.drainTaintEntries(toolsetA);
    const drainB = manager.drainTaintEntries(toolsetB);
    expect(drainA).not.toBe(drainB);
    expect(drainA.size).toBe(0);
    expect(drainB.size).toBe(0);
  });
});

// ─── Reserved-key guard: unknown `_` keys are dropped fail-closed ────────

describe('reserved memory-key guard', () => {
  it('unknown _ keys are dropped and recorded in memory_drops', () => {
    const state = baseState({});
    const next = updateMemoryReducer(state, makeAction({
      legit: 'kept',
      _smuggled_key: 'dropped',
    }));

    expect(next.memory.legit).toBe('kept');
    expect(next.memory._smuggled_key).toBeUndefined();
    const drop = next.memory_drops.find((d) => d.key === '_smuggled_key');
    expect(drop?.reason).toBe('reserved_key');
  });

  it('the guard applies to handoff memory_updates too', () => {
    const state = baseState({});
    const action = {
      id: uuidv4(),
      idempotency_key: uuidv4(),
      type: 'handoff' as const,
      payload: {
        node_id: 'peer',
        supervisor_id: 'sup',
        reasoning: 'r',
        memory_updates: { agent_output: 'kept', _sneaky: 'dropped' },
      },
      metadata: { node_id: 'sup', timestamp: new Date(), attempt: 1 },
    };
    const next = handoffReducer(state, action);

    expect(next.memory.agent_output).toBe('kept');
    expect(next.memory._sneaky).toBeUndefined();
    expect(next.memory_drops.some((d) => d.key === '_sneaky' && d.reason === 'reserved_key')).toBe(true);
  });
});
