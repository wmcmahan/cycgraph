/**
 * budget-guard.test.ts
 *
 * Unit tests for the composite-node budget guard that lets evolution /
 * annealing stop spending mid-loop instead of only being checked after the
 * whole population × generations spend has happened.
 */
import { describe, test, expect, vi } from 'vitest';

vi.mock('../src/utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { checkCompositeBudget } from '../src/runner/node-executors/budget-guard.js';
import type { GraphNode } from '../src/types/graph.js';
import type { NodeExecutorContext } from '../src/runner/node-executors/context.js';

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
  test('does not stop when no caps are configured', () => {
    const d = checkCompositeBudget(node(), { inputTokens: 1000, outputTokens: 1000, totalTokens: 2000 }, ctx());
    expect(d.stop).toBe(false);
  });

  test('stops when node max_tokens is reached (no model needed)', () => {
    const d = checkCompositeBudget(node({ max_tokens: 500 }), { inputTokens: 300, outputTokens: 300, totalTokens: 600 }, ctx());
    expect(d.stop).toBe(true);
    expect(d.reason).toMatch(/max_tokens/);
  });

  test('does not stop below node max_tokens', () => {
    const d = checkCompositeBudget(node({ max_tokens: 5000 }), { inputTokens: 300, outputTokens: 300, totalTokens: 600 }, ctx());
    expect(d.stop).toBe(false);
  });

  test('stops on node max_cost_usd once a priced model is observed', () => {
    // gpt-4 is in the pricing table; large token counts exceed a tiny cap.
    const d = checkCompositeBudget(
      node({ max_cost_usd: 0.0001 }),
      { inputTokens: 100_000, outputTokens: 100_000, totalTokens: 200_000, model: 'gpt-4o' },
      ctx(),
    );
    expect(d.stop).toBe(true);
    expect(d.reason).toMatch(/max_cost_usd/);
  });

  test('stops when accumulated cost would exceed remaining workflow budget', () => {
    const d = checkCompositeBudget(
      node(),
      { inputTokens: 100_000, outputTokens: 100_000, totalTokens: 200_000, model: 'gpt-4o' },
      ctx(0.01), // tiny remaining workflow budget
    );
    expect(d.stop).toBe(true);
    expect(d.reason).toMatch(/workflow budget/);
  });

  test('skips cost checks when the model is unknown/unpriced (token cap still applies)', () => {
    const d = checkCompositeBudget(
      node({ max_cost_usd: 0.0001 }),
      { inputTokens: 100_000, outputTokens: 100_000, totalTokens: 200_000, model: 'some-unpriced-model' },
      ctx(0.0001),
    );
    // No priced model → cost caps can't fire; with no token cap it continues.
    expect(d.stop).toBe(false);
  });
});
