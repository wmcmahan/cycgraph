/**
 * budget-guard.test.ts
 *
 * Unit tests for the composite-node budget guard that lets evolution /
 * annealing stop spending mid-loop instead of only being checked after the
 * whole population × generations spend has happened.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/observability/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { checkCompositeBudget } from '../src/execution/nodes/budget-guard.js';
import type { GraphNode } from '../src/graph/graph.js';
import type { NodeExecutorContext } from '../src/execution/nodes/context.js';

const node = (budget?: { max_tokens?: number; max_cost_usd?: number }): GraphNode => ({
  id: 'composite',
  type: 'evolution',
  read_keys: ['*'],
  write_keys: ['*'],
  failure_policy: { max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 1, max_backoff_ms: 1 },
  requires_compensation: false,
  ...(budget ? { budget } : {}),
}) as unknown as GraphNode;

const ctx = (remainingUsd?: number): NodeExecutorContext => ({
  getRemainingBudgetUsd: () => remainingUsd,
} as unknown as NodeExecutorContext);

describe('checkCompositeBudget', () => {
  it('does not stop when no caps are configured', () => {
    const d = checkCompositeBudget(node(), { inputTokens: 1000, outputTokens: 1000, totalTokens: 2000 }, ctx());
    expect(d.stop).toBe(false);
  });

  it('stops when node max_tokens is reached (no model needed)', () => {
    const d = checkCompositeBudget(node({ max_tokens: 500 }), { inputTokens: 300, outputTokens: 300, totalTokens: 600 }, ctx());
    expect(d.stop).toBe(true);
    expect(d.reason).toMatch(/max_tokens/);
  });

  it('does not stop below node max_tokens', () => {
    const d = checkCompositeBudget(node({ max_tokens: 5000 }), { inputTokens: 300, outputTokens: 300, totalTokens: 600 }, ctx());
    expect(d.stop).toBe(false);
  });

  it('stops on node max_cost_usd once a priced model is observed', () => {
    const d = checkCompositeBudget(
      node({ max_cost_usd: 0.0001 }),
      { inputTokens: 100_000, outputTokens: 100_000, totalTokens: 200_000, model: 'gpt-4o' },
      ctx(),
    );
    expect(d.stop).toBe(true);
    expect(d.reason).toMatch(/max_cost_usd/);
  });

  it('stops when accumulated cost would exceed remaining workflow budget', () => {
    const d = checkCompositeBudget(
      node(),
      { inputTokens: 100_000, outputTokens: 100_000, totalTokens: 200_000, model: 'gpt-4o' },
      ctx(0.01),
    );
    expect(d.stop).toBe(true);
    expect(d.reason).toMatch(/workflow budget/);
  });

  it('skips cost checks when the model is unknown/unpriced (token cap still applies)', () => {
    const d = checkCompositeBudget(
      node({ max_cost_usd: 0.0001 }),
      { inputTokens: 100_000, outputTokens: 100_000, totalTokens: 200_000, model: 'some-unpriced-model' },
      ctx(0.0001),
    );
    expect(d.stop).toBe(false);
  });
});
