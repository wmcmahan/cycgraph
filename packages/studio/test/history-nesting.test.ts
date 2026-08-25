/**
 * Tests for nestForks (src/run/history.ts), which groups a run's forks under
 * the run they forked instead of listing them as near-duplicate siblings.
 */

import { describe, it, expect } from 'vitest';
import { nestForks, type HistoryEntry } from '../src/run/history.js';

/** Minutes past an arbitrary epoch, so ordering is readable in the test. */
function at(minute: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();
}

function entry(runId: string, startedMinute: number, parentRunId?: string): HistoryEntry {
  return {
    dir: `/runs/x-${runId}`,
    meta: {
      runId,
      scenarioId: 'router-conditions',
      params: {},
      stack: {} as never,
      startedAt: at(startedMinute),
      status: 'completed',
      ...(parentRunId ? { parentRunId } : {}),
    },
    usage: { totalTokens: 0, totalCostUsd: 0, nodesVisited: 0 },
    evals: [],
    passed: 0,
    total: 0,
  };
}

describe('nestForks', () => {
  it('leaves an ordinary run at the top level', () => {
    const trees = nestForks([entry('base', 0)]);

    expect(trees).toHaveLength(1);
    expect(trees[0].entry.meta.runId).toBe('base');
    expect(trees[0].forks).toEqual([]);
  });

  it('puts a fork under the run it forked', () => {
    const trees = nestForks([entry('fork', 1, 'base'), entry('base', 0)]);

    expect(trees.map(t => t.entry.meta.runId)).toEqual(['base']);
    expect(trees[0].forks.map(f => f.entry.meta.runId)).toEqual(['fork']);
  });

  it('nests a fork of a fork', () => {
    const trees = nestForks([
      entry('base', 0),
      entry('fork', 1, 'base'),
      entry('deeper', 2, 'fork'),
    ]);

    expect(trees[0].forks[0].forks.map(f => f.entry.meta.runId)).toEqual(['deeper']);
  });

  it('orders a run\'s forks oldest first', () => {
    const trees = nestForks([
      entry('base', 0),
      entry('second', 5, 'base'),
      entry('first', 2, 'base'),
    ]);

    expect(trees[0].forks.map(f => f.entry.meta.runId)).toEqual(['first', 'second']);
  });

  it('keeps a fork whose parent fell outside the window', () => {
    const trees = nestForks([entry('orphan', 1, 'evicted-parent')]);

    expect(trees.map(t => t.entry.meta.runId)).toEqual(['orphan']);
  });

  it('groups several runs and their forks independently', () => {
    const trees = nestForks([
      entry('a', 0),
      entry('b', 1),
      entry('a-fork', 2, 'a'),
      entry('b-fork', 3, 'b'),
    ]);

    expect(trees.map(t => t.entry.meta.runId)).toEqual(['a', 'b']);
    expect(trees[0].forks.map(f => f.entry.meta.runId)).toEqual(['a-fork']);
    expect(trees[1].forks.map(f => f.entry.meta.runId)).toEqual(['b-fork']);
  });

  it('returns nothing for an empty listing', () => {
    expect(nestForks([])).toEqual([]);
  });
});
