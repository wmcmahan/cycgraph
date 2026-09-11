/**
 * Tests for the merge-outcome reconciler's pure parts (src/reconcile.ts).
 */

import { describe, it, expect, vi } from 'vitest';
import { mergeScore, prNumberFrom, reconcileRows } from '../src/reconcile.js';

describe('prNumberFrom', () => {
  it('extracts the number from a pull request url', () => {
    expect(prNumberFrom('https://github.com/x/y/pull/184')).toBe(184);
    expect(prNumberFrom('https://github.com/x/y/pull/184#issuecomment-1')).toBe(184);
  });

  it('returns undefined for urls that are not pull requests', () => {
    expect(prNumberFrom('https://github.com/x/y/issues/184')).toBeUndefined();
    expect(prNumberFrom('')).toBeUndefined();
  });
});

describe('mergeScore', () => {
  it('scores merged 1 and closed-unmerged 0', () => {
    expect(mergeScore('MERGED')).toBe(1);
    expect(mergeScore('CLOSED')).toBe(0);
  });

  it('leaves open and unreadable states undecided', () => {
    expect(mergeScore('OPEN')).toBeUndefined();
    expect(mergeScore('UNREADABLE')).toBeUndefined();
  });
});

describe('reconcileRows', () => {
  const publishedRow = (overrides: Partial<{ run_id: string; pr_url: string; lesson_provenance: unknown }> = {}) => ({
    run_id: 'run-1',
    pr_url: 'https://github.com/x/y/pull/42',
    lesson_provenance: { entry: { fact_ids: ['fact-a', 'fact-b'], retrieved_at: 'now', node_id: 'fix', query: {} } },
    ...overrides,
  });

  it('records score 1 with the run\'s fact ids when the PR merged', async () => {
    const recordOutcome = vi.fn(async () => undefined);

    const result = await reconcileRows([publishedRow()], {
      apply: true,
      readPrState: async () => 'MERGED',
      recordOutcome,
    });

    expect(recordOutcome).toHaveBeenCalledWith('run-1', 1, ['fact-a', 'fact-b']);
    expect(result).toEqual([{ runId: 'run-1', pr: 42, state: 'MERGED', score: 1, factIds: 2 }]);
  });

  it('never records an unreadable PR', async () => {
    const recordOutcome = vi.fn(async () => undefined);

    const result = await reconcileRows([publishedRow()], {
      apply: true,
      readPrState: async () => 'UNREADABLE',
      recordOutcome,
    });

    expect(recordOutcome).not.toHaveBeenCalled();
    expect(result[0]!.score).toBeUndefined();
  });

  it('records nothing on a dry run while still reporting scores', async () => {
    const recordOutcome = vi.fn(async () => undefined);

    const result = await reconcileRows([publishedRow()], {
      apply: false,
      readPrState: async () => 'CLOSED',
      recordOutcome,
    });

    expect(recordOutcome).not.toHaveBeenCalled();
    expect(result[0]!.score).toBe(0);
  });

  it('skips rows whose publish url is not a pull request', async () => {
    const result = await reconcileRows([publishedRow({ pr_url: 'https://github.com/x/y/issues/9' })], {
      apply: true,
      readPrState: async () => 'MERGED',
      recordOutcome: vi.fn(async () => undefined),
    });

    expect(result).toEqual([]);
  });
});
