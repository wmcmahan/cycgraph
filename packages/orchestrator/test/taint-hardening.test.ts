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
import { describe, test, expect, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';

vi.mock('../src/utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { updateMemoryReducer, mergeParallelResultsReducer } from '../src/reducers/index.js';
import { executeToolNode } from '../src/runner/node-executors/tool.js';
import { MCPConnectionManager } from '../src/mcp/connection-manager.js';
import { InMemoryMCPServerRegistry } from '../src/persistence/in-memory.js';
import { getTaintRegistry } from '../src/utils/taint.js';
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

function baseState(memory: Record<string, unknown>): WorkflowState {
  return {
    state_schema_version: 1,
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

  test('a crafted empty _taint_registry preserves existing entries', () => {
    const state = baseState({ page: 'attacker text', _taint_registry: existingTaint });
    const next = updateMemoryReducer(state, makeAction({ _taint_registry: {} }));
    expect(next.memory._taint_registry).toEqual(existingTaint);
  });

  test('overwriting a specific key to remove its taint is ignored (merge keeps it)', () => {
    const state = baseState({ page: 'x', _taint_registry: existingTaint });
    // Attacker tries to drop the `page` taint by sending a registry without it.
    const next = updateMemoryReducer(state, makeAction({
      _taint_registry: { other: { source: 'derived', created_at: '2026-01-02T00:00:00Z' } },
    }));
    const reg = next.memory._taint_registry as Record<string, unknown>;
    expect(reg.page).toEqual(existingTaint.page); // still tainted
    expect(reg.other).toBeDefined();              // new entry added
  });

  test('legitimate additive taint writes still work', () => {
    const state = baseState({ _taint_registry: existingTaint });
    const next = updateMemoryReducer(state, makeAction({
      _taint_registry: { ...existingTaint, doc: { source: 'mcp_tool', tool_name: 'search', server_id: 'web', created_at: '2026-01-03T00:00:00Z' } },
    }));
    const reg = next.memory._taint_registry as Record<string, unknown>;
    expect(Object.keys(reg).sort()).toEqual(['doc', 'page']);
  });

  test('merge_parallel_results is also append-only for taint', () => {
    const state = baseState({ _taint_registry: existingTaint });
    const next = mergeParallelResultsReducer(
      state,
      makeAction({ _taint_registry: {} }, 'merge_parallel_results'),
    );
    expect(next.memory._taint_registry).toEqual(existingTaint);
  });
});

// ─── H1 + race: tool-node taint via per-resolution collector ────────────

describe('H1: standalone tool nodes taint MCP output', () => {
  test('drains taint from the resolution collector and marks the result key', async () => {
    // executeToolNode with a stub resolver that mimics MCPConnectionManager:
    // resolveTools returns a tool and drainTaintEntries(tools) returns the
    // accumulated entry for that exact toolset.
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
        getTaintRegistry: (mem: Record<string, unknown>) => getTaintRegistry(mem),
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
    // Drain was called with the exact toolset (race-free path).
    expect(ctx.deps.drainTaintEntries).toHaveBeenCalledWith(resolvedTools);
  });

  test('no taint entries → result written untainted (no false positives)', async () => {
    const resolvedTools = { calc: { execute: async () => 42 } };
    const ctx = {
      state: baseState({}),
      graph: { id: 'g' },
      deps: {
        resolveTools: vi.fn().mockResolvedValue(resolvedTools),
        drainTaintEntries: vi.fn(() => new Map()),
        getTaintRegistry: (mem: Record<string, unknown>) => getTaintRegistry(mem),
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
  test('two toolsets drain independently', async () => {
    const registry = new InMemoryMCPServerRegistry();
    const manager = new MCPConnectionManager(registry);

    // Simulate two independent resolutions by registering two distinct
    // toolset objects with the manager's collector map via resolveTools.
    // resolveTools with no sources returns an (empty) toolset that still
    // gets a registered collector — exercising the WeakMap keying.
    const toolsetA = await manager.resolveTools([]);
    const toolsetB = await manager.resolveTools([]);
    expect(toolsetA).not.toBe(toolsetB);

    // Draining one returns its own (empty) collector and does not throw,
    // and the two are distinct map instances.
    const drainA = manager.drainTaintEntries(toolsetA);
    const drainB = manager.drainTaintEntries(toolsetB);
    expect(drainA).not.toBe(drainB);
    expect(drainA.size).toBe(0);
    expect(drainB.size).toBe(0);
  });
});
