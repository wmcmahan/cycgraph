/**
 * Tests for budget/cache-diagnostics — cross-turn segment stability report.
 */

import { describe, it, expect } from 'vitest';
import { diagnoseCacheStability } from '../src/budget/cache-diagnostics.js';
import { computeSegmentHashMap } from '../src/budget/cache-policy.js';
import { seg } from './helpers.js';

describe('diagnoseCacheStability', () => {
  it('reports a perfect hit rate when every comparable segment is unchanged', () => {
    const segments = [seg('a', 'hello world'), seg('b', 'foo bar')];
    const previous = computeSegmentHashMap(segments);

    const diag = diagnoseCacheStability(segments, previous);

    expect(diag.hitRate).toBe(1.0);
    expect(diag.unstableSegments).toHaveLength(0);
    expect(diag.recommendations).toHaveLength(0);
  });

  it('flags a single mutated segment and halves the hit rate', () => {
    const previous = computeSegmentHashMap([seg('a', 'hello world'), seg('b', 'foo bar')]);
    const current = [seg('a', 'hello world'), seg('b', 'foo bar changed')];

    const diag = diagnoseCacheStability(current, previous);

    expect(diag.hitRate).toBe(0.5);
    expect(diag.unstableSegments).toHaveLength(1);
    expect(diag.unstableSegments[0].id).toBe('b');
  });

  it('reports the previous and current hashes of an unstable segment', () => {
    const previous = computeSegmentHashMap([seg('a', 'hello')]);
    const previousHash = previous.get('a')!;
    const current = [seg('a', 'goodbye')];
    const currentHash = computeSegmentHashMap(current).get('a')!;

    const diag = diagnoseCacheStability(current, previous);

    expect(diag.unstableSegments[0].hashPrevious).toBe(previousHash);
    expect(diag.unstableSegments[0].hashCurrent).toBe(currentHash);
  });

  it('names the segment id and role in each recommendation', () => {
    const previous = computeSegmentHashMap([seg('sys-prompt', 'original content', 'system')]);
    const current = [seg('sys-prompt', 'modified content', 'system')];

    const diag = diagnoseCacheStability(current, previous);

    expect(diag.recommendations).toHaveLength(1);
    expect(diag.recommendations[0]).toContain('sys-prompt');
    expect(diag.recommendations[0]).toContain('system');
  });

  it('reports a zero hit rate when every comparable segment changed', () => {
    const previous = computeSegmentHashMap([seg('a', 'hello'), seg('b', 'world')]);
    const current = [seg('a', 'changed-a'), seg('b', 'changed-b')];

    const diag = diagnoseCacheStability(current, previous);

    expect(diag.hitRate).toBe(0);
    expect(diag.unstableSegments).toHaveLength(2);
    expect(diag.recommendations).toHaveLength(2);
  });

  it('returns a perfect hit rate when no segments are comparable', () => {
    const diag = diagnoseCacheStability([seg('a', 'hello'), seg('b', 'world')], new Map());

    expect(diag.hitRate).toBe(1.0);
    expect(diag.unstableSegments).toHaveLength(0);
  });

  it('excludes new segments from the hit rate', () => {
    const previous = computeSegmentHashMap([seg('a', 'hello')]);
    const current = [seg('a', 'hello'), seg('b', 'new segment')];

    const diag = diagnoseCacheStability(current, previous);

    expect(diag.hitRate).toBe(1.0);
    expect(diag.unstableSegments).toHaveLength(0);
  });

  it('excludes removed segments from the hit rate', () => {
    const previous = computeSegmentHashMap([seg('a', 'hello'), seg('b', 'world')]);
    const current = [seg('a', 'hello')];

    const diag = diagnoseCacheStability(current, previous);

    expect(diag.hitRate).toBe(1.0);
    expect(diag.unstableSegments).toHaveLength(0);
  });

  it('scores only comparable segments across a mix of new, stable, unstable, and removed', () => {
    const previous = computeSegmentHashMap([
      seg('stable', 'same'),
      seg('changed', 'before'),
      seg('removed', 'gone'),
    ]);
    const current = [seg('stable', 'same'), seg('changed', 'after'), seg('new', 'fresh')];

    const diag = diagnoseCacheStability(current, previous);

    expect(diag.hitRate).toBe(0.5);
    expect(diag.unstableSegments).toHaveLength(1);
    expect(diag.unstableSegments[0].id).toBe('changed');
  });
});

describe('computeSegmentHashMap', () => {
  it('maps every segment id to a numeric hash', () => {
    const map = computeSegmentHashMap([seg('a', 'hello'), seg('b', 'world')]);

    expect(map.size).toBe(2);
    expect(typeof map.get('a')).toBe('number');
    expect(typeof map.get('b')).toBe('number');
  });

  it('produces identical hashes for identical content', () => {
    const a = computeSegmentHashMap([seg('x', 'identical')]);
    const b = computeSegmentHashMap([seg('x', 'identical')]);
    expect(a.get('x')).toBe(b.get('x'));
  });

  it('produces different hashes for different content', () => {
    const a = computeSegmentHashMap([seg('x', 'hello')]);
    const b = computeSegmentHashMap([seg('x', 'world')]);
    expect(a.get('x')).not.toBe(b.get('x'));
  });
});
