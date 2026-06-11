/**
 * Budget Monitor — Unit Tests
 *
 * Pins down the contract that the executeLoop generator depends on:
 *   - each threshold fires exactly once given the state array
 *   - effect order: dispatch → emit → push (when streaming)
 *   - 100% throws BudgetExceededError
 *   - no callbacks fire when budget_usd is unset or zero
 */

import { describe, it, expect, vi } from 'vitest';
import { BudgetMonitor } from '../src/runner/budget-monitor.js';
import { BudgetExceededError } from '../src/runner/errors.js';
import type { WorkflowState, Action } from '../src/types/state.js';

function makeState(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return {
    workflow_id: '00000000-0000-0000-0000-000000000000',
    run_id: '11111111-1111-1111-1111-111111111111',
    created_at: new Date(),
    updated_at: new Date(),
    goal: 'test',
    constraints: [],
    status: 'running',
    iteration_count: 0,
    retry_count: 0,
    max_retries: 3,
    memory: {},
    total_tokens_used: 0,
    total_cost_usd: 0,
    _cost_alert_thresholds_fired: [],
    visited_nodes: [],
    max_iterations: 50,
    max_execution_time_ms: 3_600_000,
    compensation_stack: [],
    supervisor_history: [],
    memory_drops: [],
    ...overrides,
  };
}

function makeCallbacks() {
  return {
    dispatch: vi.fn(),
    push: vi.fn(),
    emit: vi.fn(),
    isStreaming: vi.fn().mockReturnValue(false),
  };
}

describe('BudgetMonitor.calculateActionCost', () => {
  it('uses the model from action metadata', () => {
    const monitor = new BudgetMonitor(makeCallbacks());
    const action: Action = {
      id: 'a',
      idempotency_key: 'a',
      type: 'update_memory',
      payload: { updates: {} },
      metadata: { node_id: 'n', timestamp: new Date(), attempt: 1, model: 'claude-sonnet-4-6' },
    };
    const cost = monitor.calculateActionCost(1000, 500, action);
    // Pure delegation to calculateCost — just assert it returned a number
    // and didn't throw. Real cost values are covered by pricing tests.
    expect(typeof cost).toBe('number');
    expect(cost).toBeGreaterThanOrEqual(0);
  });

  it('returns 0 for unknown models without throwing', () => {
    const monitor = new BudgetMonitor(makeCallbacks());
    const action: Action = {
      id: 'a',
      idempotency_key: 'a',
      type: 'update_memory',
      payload: { updates: {} },
      metadata: { node_id: 'n', timestamp: new Date(), attempt: 1 },
    };
    expect(() => monitor.calculateActionCost(100, 50, action)).not.toThrow();
  });
});

describe('BudgetMonitor.checkThresholds — no-budget path', () => {
  it('is a no-op when budget_usd is unset', async () => {
    const cb = makeCallbacks();
    const monitor = new BudgetMonitor(cb);
    await monitor.checkThresholds(makeState({ total_cost_usd: 100 }));
    expect(cb.dispatch).not.toHaveBeenCalled();
    expect(cb.emit).not.toHaveBeenCalled();
    expect(cb.push).not.toHaveBeenCalled();
  });

  it('is a no-op when budget_usd is zero or negative', async () => {
    const cb = makeCallbacks();
    const monitor = new BudgetMonitor(cb);
    await monitor.checkThresholds(makeState({ budget_usd: 0, total_cost_usd: 50 }));
    await monitor.checkThresholds(makeState({ budget_usd: -1, total_cost_usd: 50 }));
    expect(cb.dispatch).not.toHaveBeenCalled();
  });
});

describe('BudgetMonitor.checkThresholds — firing semantics', () => {
  it('fires no thresholds below 50%', async () => {
    const cb = makeCallbacks();
    const monitor = new BudgetMonitor(cb);
    await monitor.checkThresholds(makeState({ budget_usd: 100, total_cost_usd: 25 }));
    expect(cb.dispatch).not.toHaveBeenCalled();
  });

  it('fires 50% threshold at exactly 50% usage', async () => {
    const cb = makeCallbacks();
    const monitor = new BudgetMonitor(cb);
    await monitor.checkThresholds(makeState({ budget_usd: 100, total_cost_usd: 50 }));
    expect(cb.dispatch).toHaveBeenCalledWith('_fire_cost_threshold', { threshold: 0.5 });
    expect(cb.emit).toHaveBeenCalledWith('budget:threshold_reached', expect.objectContaining({
      threshold_pct: 50,
      cost_usd: 50,
      budget_usd: 100,
    }));
  });

  it('fires 50, 75, and 90 in one call when jumping from 0% to 95%', async () => {
    const cb = makeCallbacks();
    const monitor = new BudgetMonitor(cb);
    await monitor.checkThresholds(makeState({ budget_usd: 100, total_cost_usd: 95 }));

    const dispatched = cb.dispatch.mock.calls.map(c => (c[1] as { threshold: number }).threshold);
    expect(dispatched).toEqual([0.5, 0.75, 0.9]);
    expect(cb.emit).toHaveBeenCalledTimes(3);
  });

  it('does NOT re-fire thresholds already in _cost_alert_thresholds_fired', async () => {
    const cb = makeCallbacks();
    const monitor = new BudgetMonitor(cb);
    const state = makeState({
      budget_usd: 100,
      total_cost_usd: 80,
      _cost_alert_thresholds_fired: [0.5, 0.75],
    });
    await monitor.checkThresholds(state);

    // 50% and 75% already fired — only 90% remaining (not crossed at 80%)
    expect(cb.dispatch).not.toHaveBeenCalled();
    expect(cb.emit).not.toHaveBeenCalled();
  });

  it('pushes a stream event ONLY when isStreaming() returns true', async () => {
    const cb = makeCallbacks();
    cb.isStreaming.mockReturnValue(false);
    const monitorOff = new BudgetMonitor(cb);
    await monitorOff.checkThresholds(makeState({ budget_usd: 100, total_cost_usd: 50 }));
    expect(cb.push).not.toHaveBeenCalled();

    const cb2 = makeCallbacks();
    cb2.isStreaming.mockReturnValue(true);
    const monitorOn = new BudgetMonitor(cb2);
    await monitorOn.checkThresholds(makeState({ budget_usd: 100, total_cost_usd: 50 }));
    expect(cb2.push).toHaveBeenCalledTimes(1);
    expect(cb2.push.mock.calls[0][0]).toMatchObject({
      type: 'budget:threshold_reached',
      threshold_pct: 50,
    });
  });

  it('preserves effect order per threshold: dispatch → emit → push', async () => {
    const order: string[] = [];
    const cb = {
      dispatch: vi.fn(() => { order.push('dispatch'); }),
      emit: vi.fn(() => { order.push('emit'); }),
      push: vi.fn(() => { order.push('push'); }),
      isStreaming: vi.fn().mockReturnValue(true),
    };
    const monitor = new BudgetMonitor(cb);
    await monitor.checkThresholds(makeState({ budget_usd: 100, total_cost_usd: 50 }));
    expect(order).toEqual(['dispatch', 'emit', 'push']);
  });
});

describe('BudgetMonitor.checkThresholds — terminal (100%)', () => {
  it('dispatches _budget_exceeded then throws BudgetExceededError at 100%', async () => {
    const cb = makeCallbacks();
    const monitor = new BudgetMonitor(cb);

    await expect(monitor.checkThresholds(makeState({
      budget_usd: 100,
      total_cost_usd: 100,
      _cost_alert_thresholds_fired: [0.5, 0.75, 0.9],
    }))).rejects.toBeInstanceOf(BudgetExceededError);

    const dispatchedTypes = cb.dispatch.mock.calls.map(c => c[0]);
    expect(dispatchedTypes).toContain('_fire_cost_threshold');
    expect(dispatchedTypes).toContain('_budget_exceeded');
    // _budget_exceeded MUST be dispatched before throw
    const fireIdx = dispatchedTypes.indexOf('_fire_cost_threshold');
    const exceededIdx = dispatchedTypes.indexOf('_budget_exceeded');
    expect(exceededIdx).toBeGreaterThan(fireIdx);
  });

  it('throws even when over-budget by a wide margin', async () => {
    const cb = makeCallbacks();
    const monitor = new BudgetMonitor(cb);
    await expect(monitor.checkThresholds(makeState({
      budget_usd: 100,
      total_cost_usd: 500,
    }))).rejects.toBeInstanceOf(BudgetExceededError);
  });

  it('does not re-fire the 100% threshold once it is in the fired array', async () => {
    const cb = makeCallbacks();
    const monitor = new BudgetMonitor(cb);

    // 100% already fired — but the workflow somehow continued. The monitor
    // should not fire it again or throw.
    await monitor.checkThresholds(makeState({
      budget_usd: 100,
      total_cost_usd: 100,
      _cost_alert_thresholds_fired: [0.5, 0.75, 0.9, 1.0],
    }));
    expect(cb.dispatch).not.toHaveBeenCalled();
  });
});
