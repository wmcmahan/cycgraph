/**
 * Tests for budget/cache-policy — prefix locking and cache-stability measures.
 */

import { describe, it, expect } from 'vitest';
import {
  applyCachePolicy,
  computePrefixHashes,
  measureCacheHitRate,
  computePrefixHashList,
  measurePrefixStability,
} from '../src/budget/cache-policy.js';
import type { PromptSegment } from '../src/pipeline/types.js';
import { seg } from './helpers.js';

describe('applyCachePolicy', () => {
  it('locks system segments by default', () => {
    const result = applyCachePolicy([seg('sys', 'prompt', 'system'), seg('mem', 'data', 'memory')]);
    expect(result[0].locked).toBe(true);
    expect(result[1].locked).toBe(false);
  });

  it('locks tools segments by default', () => {
    const result = applyCachePolicy([seg('tools', 'schemas', 'tools'), seg('hist', 'chat', 'history')]);
    expect(result[0].locked).toBe(true);
    expect(result[1].locked).toBe(false);
  });

  it('can disable system and tools locking', () => {
    const result = applyCachePolicy([seg('sys', 's', 'system'), seg('tools', 't', 'tools')], {
      lockSystem: false,
      lockTools: false,
    });
    expect(result[0].locked).toBe(false);
    expect(result[1].locked).toBe(false);
  });

  it('locks the first N segments regardless of role', () => {
    const segments = [seg('a', 'first'), seg('b', 'second'), seg('c', 'third')];
    const result = applyCachePolicy(segments, { lockFirstN: 2, lockSystem: false, lockTools: false });
    expect(result.map(s => s.locked)).toEqual([true, true, false]);
  });

  it('locks segments matching a custom predicate', () => {
    const segments = [seg('a', 'important', 'custom'), seg('b', 'not important', 'custom')];
    const result = applyCachePolicy(segments, {
      lockSystem: false,
      lockTools: false,
      lockPredicate: s => s.content.includes('important') && !s.content.includes('not'),
    });
    expect(result[0].locked).toBe(true);
    expect(result[1].locked).toBe(false);
  });

  it('preserves pre-existing locks', () => {
    const result = applyCachePolicy([seg('a', 'locked', 'memory', { locked: true })], {
      lockSystem: false,
      lockTools: false,
    });
    expect(result[0].locked).toBe(true);
  });

  it('does not mutate the input segments', () => {
    const segments = [seg('sys', 'system', 'system')];
    const result = applyCachePolicy(segments);
    expect(result[0]).not.toBe(segments[0]);
    expect(segments[0].locked).toBe(false);
  });

  it('adds no locks when the model profile has no prompt cache', () => {
    const segments = [seg('sys', 'prompt', 'system'), seg('pre', 'locked', 'memory', { locked: true })];
    const result = applyCachePolicy(segments, { model: 'llama-3-70b' });
    expect(result[0].locked).toBe(false);
    expect(result[1].locked).toBe(true);
  });

  it('locks normally for a caching-capable model', () => {
    const result = applyCachePolicy([seg('sys', 'prompt', 'system')], { model: 'claude-sonnet-4-6' });
    expect(result[0].locked).toBe(true);
  });
});

describe('computePrefixHashes', () => {
  it('hashes only the locked segments', () => {
    const segments = [
      seg('sys', 'system prompt', 'system', { locked: true }),
      seg('mem', 'memory data', 'memory'),
    ];
    expect(computePrefixHashes(segments).size).toBe(1);
  });

  it('returns an empty set when no segment is locked', () => {
    expect(computePrefixHashes([seg('mem', 'data')]).size).toBe(0);
  });
});

describe('computePrefixHashList', () => {
  it('collects locked-segment hashes in prompt order, skipping unlocked ones', () => {
    const locked = [
      seg('a', 'alpha', 'system', { locked: true }),
      seg('mid', 'unlocked', 'memory'),
      seg('b', 'beta', 'system', { locked: true }),
    ];
    const expected = [
      ...computePrefixHashList([seg('a', 'alpha', 'system', { locked: true })]),
      ...computePrefixHashList([seg('b', 'beta', 'system', { locked: true })]),
    ];

    expect(computePrefixHashList(locked)).toEqual(expected);
  });

  it('returns an empty list when no segment is locked', () => {
    const segments: PromptSegment[] = [seg('a', 'x'), seg('b', 'y')];
    expect(computePrefixHashList(segments)).toEqual([]);
  });
});

describe('measurePrefixStability', () => {
  function lockedList(...contents: string[]): number[] {
    return computePrefixHashList(contents.map((c, i) => seg(`s${i}`, c, 'system', { locked: true })));
  }

  it('returns 1.0 when the previous prefix is fully preserved', () => {
    expect(measurePrefixStability(lockedList('a', 'b', 'c'), lockedList('a', 'b', 'c'))).toBe(1.0);
  });

  it('counts only the common prefix when a mid-sequence segment changes', () => {
    const prev = lockedList('a', 'b', 'c', 'd');
    const curr = lockedList('a', 'CHANGED', 'c', 'd');
    expect(measurePrefixStability(curr, prev)).toBe(0.25);
  });

  it('treats reordering as full invalidation', () => {
    const prev = lockedList('a', 'b');
    const curr = lockedList('b', 'a');
    expect(measurePrefixStability(curr, prev)).toBe(0);
  });

  it('returns 1.0 for an empty previous prefix', () => {
    expect(measurePrefixStability([1, 2], [])).toBe(1.0);
  });
});

describe('measureCacheHitRate', () => {
  it('returns 1.0 for identical hash sets', () => {
    const hashes = new Set([123, 456]);
    expect(measureCacheHitRate(hashes, hashes)).toBe(1.0);
  });

  it('returns 0.0 when no hashes overlap', () => {
    expect(measureCacheHitRate(new Set([789]), new Set([123]))).toBe(0.0);
  });

  it('returns the overlap fraction for partial overlap', () => {
    expect(measureCacheHitRate(new Set([123, 789]), new Set([123, 456]))).toBe(0.5);
  });

  it('ignores order, reporting 1.0 for a reordered set (the upper bound)', () => {
    const prev = lockedContentHashes('a', 'b');
    const curr = lockedContentHashes('b', 'a');
    expect(measureCacheHitRate(new Set(curr), new Set(prev))).toBe(1.0);
  });

  it('returns 1.0 when the previous set is empty', () => {
    expect(measureCacheHitRate(new Set([123]), new Set())).toBe(1.0);
  });
});

function lockedContentHashes(...contents: string[]): number[] {
  return computePrefixHashList(contents.map((c, i) => seg(`s${i}`, c, 'system', { locked: true })));
}
