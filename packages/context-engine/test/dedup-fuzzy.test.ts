/**
 * Tests for fuzzy (trigram Jaccard) deduplication — `src/memory/dedup/fuzzy.ts`.
 * Covers the small-input pairwise path and the MinHash LSH pre-filter used
 * for inputs over 200 items.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  trigramSet,
  jaccardSimilarity,
  minHashSignature,
  lshCandidatePairs,
  fuzzyDedup,
  createFuzzyDedupStage,
} from '../src/memory/dedup/fuzzy.js';
import { seg, makeContext } from './helpers.js';

const LSH_THRESHOLD = 0.99;
const EXACT_DUP = 'The zephyr protocol validates quorum across replicated ledger shards worldwide.';
const NEAR_DUP_A = 'Marmot telemetry ingests seismic vibration samples from remote alpine sensors.';
const NEAR_DUP_B = 'Marmot telemetry ingests seismic vibration samples from distant alpine sensors.';
const TOO_SHORT = 'hi';

function lshCorpus(): string[] {
  const fillers = Array.from(
    { length: 196 },
    (_, i) => `Ledger entry number ${i} records account ${i} balance and audit trail metadata.`,
  );
  return [EXACT_DUP, EXACT_DUP, NEAR_DUP_A, NEAR_DUP_B, TOO_SHORT, ...fillers];
}

describe('trigramSet', () => {
  it('generates one trigram per sliding window of three characters', () => {
    const trigrams = trigramSet('hello');

    expect([...trigrams].sort()).toEqual(['ell', 'hel', 'llo']);
  });

  it('is case-insensitive', () => {
    expect(trigramSet('Hello')).toEqual(trigramSet('hello'));
  });

  it('returns an empty set for strings shorter than three characters', () => {
    expect(trigramSet('ab').size).toBe(0);
    expect(trigramSet('').size).toBe(0);
  });
});

describe('jaccardSimilarity', () => {
  it('returns 1.0 for identical sets', () => {
    const a = trigramSet('hello world');

    expect(jaccardSimilarity(a, a)).toBe(1.0);
  });

  it('returns 0.0 for disjoint sets', () => {
    expect(jaccardSimilarity(new Set(['abc', 'def']), new Set(['xyz', 'uvw']))).toBe(0.0);
  });

  it('returns a value strictly between 0 and 1 for partial overlap', () => {
    const sim = jaccardSimilarity(trigramSet('hello world'), trigramSet('hello earth'));

    expect(sim).toBeGreaterThan(0);
    expect(sim).toBeLessThan(1);
  });

  it('treats two empty sets as identical', () => {
    expect(jaccardSimilarity(new Set(), new Set())).toBe(1.0);
  });

  it('treats one empty set against a non-empty set as disjoint', () => {
    expect(jaccardSimilarity(new Set(['a']), new Set())).toBe(0.0);
  });
});

describe('minHashSignature', () => {
  it('produces one entry per hash function', () => {
    const signature = minHashSignature(trigramSet('hello world'), 16);

    expect(signature).toHaveLength(16);
  });

  it('produces identical signatures for identical trigram sets', () => {
    const a = minHashSignature(trigramSet('replicated ledger shards'), 32);
    const b = minHashSignature(trigramSet('replicated ledger shards'), 32);

    expect(a).toEqual(b);
  });

  it('leaves the signature at the initial maximum when the trigram set is empty', () => {
    const signature = minHashSignature(new Set(), 4);

    expect(signature).toEqual([0xffffffff, 0xffffffff, 0xffffffff, 0xffffffff]);
  });
});

describe('lshCandidatePairs', () => {
  it('pairs two items that collide in the same band', () => {
    const signatures = [
      [1, 1, 2, 2],
      [1, 1, 9, 9],
    ];

    const candidates = lshCandidatePairs(signatures, 2, 2);

    expect([...candidates]).toEqual(['0:1']);
  });

  it('collects candidates from every band a pair shares', () => {
    const signatures = [
      [1, 1, 2, 2],
      [1, 1, 9, 9],
      [5, 5, 2, 2],
    ];

    const candidates = lshCandidatePairs(signatures, 2, 2);

    expect([...candidates].sort()).toEqual(['0:1', '0:2']);
  });

  it('returns no candidates when no band buckets collide', () => {
    const signatures = [
      [1, 2, 3, 4],
      [5, 6, 7, 8],
    ];

    expect(lshCandidatePairs(signatures, 2, 2).size).toBe(0);
  });

  it('returns an empty set for no signatures', () => {
    expect(lshCandidatePairs([], 2, 2).size).toBe(0);
  });
});

describe('fuzzyDedup', () => {
  it('removes a near-duplicate differing by a single trailing word', () => {
    const items = [
      'Multi-agent systems cost 5-10x more than single-agent setups in production environments today',
      'Multi-agent systems cost 5-10x more than single-agent setups in production environments now',
    ];

    const result = fuzzyDedup(items, { threshold: 0.8 });

    expect(result.removed).toBe(1);
    expect(result.unique).toHaveLength(1);
  });

  it('keeps both items when they are sufficiently different', () => {
    const items = [
      'Multi-agent systems are expensive to operate',
      'Local deployment improves data sovereignty and compliance',
    ];

    const result = fuzzyDedup(items);

    expect(result.removed).toBe(0);
    expect(result.unique).toHaveLength(2);
  });

  it('keeps the shorter of two near-duplicates', () => {
    const shorter = 'Agents cost 5-10x more than single-agent setups in production';
    const longer = 'Agents cost 5-10x more than single-agent setups in production environments and deployments';

    const result = fuzzyDedup([longer, shorter], { threshold: 0.7 });

    expect(result.unique).toEqual([shorter]);
  });

  it('keeps the shortest item from a cluster of three similar items', () => {
    const short = 'Multi-agent systems cost 5-10x more in production';
    const medium = 'Multi-agent systems cost 5-10x more in production environments today';
    const long = 'Multi-agent systems cost 5-10x more in production environments today and tomorrow morning';

    const result = fuzzyDedup([long, medium, short], { threshold: 0.7 });

    expect(result.unique).toEqual([short]);
  });

  it('skips items shorter than minLength', () => {
    const result = fuzzyDedup(['hi', 'hello'], { minLength: 20 });

    expect(result.removed).toBe(0);
    expect(result.unique).toHaveLength(2);
  });

  it('keeps a too-short item that cannot be compared against a longer one', () => {
    const result = fuzzyDedup(['A sufficiently long sentence about deduplication behaviour', 'hi']);

    expect(result.removed).toBe(0);
    expect(result.unique).toHaveLength(2);
  });

  it('matches near-duplicates at a loose threshold but not a strict one', () => {
    const items = [
      'The quick brown fox jumps over the lazy dog in the park',
      'The quick brown fox jumps over the lazy cat in the park',
    ];

    expect(fuzzyDedup(items, { threshold: 0.5 }).removed).toBe(1);
    expect(fuzzyDedup(items, { threshold: 0.99 }).removed).toBe(0);
  });

  it('returns an empty result for empty input', () => {
    const result = fuzzyDedup([]);

    expect(result.unique).toEqual([]);
    expect(result.removed).toBe(0);
  });

  it('returns a single item unchanged', () => {
    const result = fuzzyDedup(['only one item here for testing']);

    expect(result.unique).toHaveLength(1);
    expect(result.removed).toBe(0);
  });

  it('keeps the same items regardless of input order', () => {
    const base = 'Multi-agent systems cost 5-10x more than single-agent setups in production environments';
    const a = base + ' today and tomorrow';
    const b = base + ' now and forever';
    const c = base + ' currently and always';

    const order1 = new Set(fuzzyDedup([a, b, c], { threshold: 0.8 }).unique);
    const order2 = new Set(fuzzyDedup([c, b, a], { threshold: 0.8 }).unique);
    const order3 = new Set(fuzzyDedup([b, a, c], { threshold: 0.8 }).unique);

    expect(order1).toEqual(order2);
    expect(order2).toEqual(order3);
  });

  it('uses the LSH pre-filter for inputs over 200 items, removing exact duplicates', () => {
    const result = fuzzyDedup(lshCorpus(), { threshold: LSH_THRESHOLD });

    expect(result.removed).toBe(1);
    expect(result.unique).toHaveLength(200);
    expect(result.unique.filter(t => t === EXACT_DUP)).toHaveLength(1);
  });

  it('leaves LSH candidate pairs below the threshold untouched', () => {
    const result = fuzzyDedup(lshCorpus(), { threshold: LSH_THRESHOLD });

    expect(result.unique).toContain(NEAR_DUP_A);
    expect(result.unique).toContain(NEAR_DUP_B);
  });

  it('passes an item too short to compare through the LSH path unchanged', () => {
    const result = fuzzyDedup(lshCorpus(), { threshold: LSH_THRESHOLD });

    expect(result.unique).toContain(TOO_SHORT);
  });

  it('caps pairwise comparison at maxItems and passes the remainder through undeduped', () => {
    const base = 'Multi-agent systems cost 5-10x more than single-agent setups in production environments';
    const items = [
      base + ' today',
      base + ' now',
      base + ' currently',
      base + ' forever',
      'Completely different content about local deployment and data sovereignty compliance requirements',
    ];

    const result = fuzzyDedup(items, { threshold: 0.8, maxItems: 3 });

    expect(result.unique).toContain(items[3]);
    expect(result.unique).toContain(items[4]);
    expect(result.removed).toBeGreaterThan(0);
  });

  it('logs a warning when items exceed maxItems', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const items = Array.from({ length: 5 }, (_, i) => `Item number ${i} is long enough for comparison here and now`);

    fuzzyDedup(items, { maxItems: 3 });

    expect(warnSpy).toHaveBeenCalledWith('context-engine: fuzzy dedup capped at 3 items (5 provided)');
    warnSpy.mockRestore();
  });

  it('does not warn when items are within the default maxItems', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const items = Array.from({ length: 10 }, (_, i) => `Unique item number ${i} with sufficient length for comparison`);

    fuzzyDedup(items);

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe('createFuzzyDedupStage', () => {
  const context = makeContext();

  it('has name fuzzy-dedup', () => {
    expect(createFuzzyDedupStage().name).toBe('fuzzy-dedup');
  });

  it('is declared cross-segment', () => {
    expect(createFuzzyDedupStage().scope).toBe('cross-segment');
  });

  it('removes a near-duplicate paragraph shared across two segments', () => {
    const stage = createFuzzyDedupStage({ threshold: 0.8 });
    const shared = 'Multi-agent systems cost 5-10x more than single-agent setups in production environments today';
    const seg1 = seg('a', `${shared}\n\nContext compression reduces token costs by 40-60% on average.`);
    const seg2 = seg('b', `${shared.replace('today', 'now')}\n\nLocal deployment improves data sovereignty and compliance requirements.`);

    const result = stage.execute([seg1, seg2], context);
    const combined = result.segments.map(s => s.content).join(' ');

    expect(combined).toContain('token costs');
    expect(combined).toContain('sovereignty');
    const inputLength = seg1.content.length + seg2.content.length;
    const outputLength = result.segments[0].content.length + result.segments[1].content.length;
    expect(outputLength).toBeLessThan(inputLength);
  });

  it('passes single-paragraph content through unchanged', () => {
    const stage = createFuzzyDedupStage();
    const input = seg('a', 'Just a single paragraph of unique content that should pass through unchanged.');

    const result = stage.execute([input], context);

    expect(result.segments[0].content).toBe(input.content);
  });

  it('leaves a structured JSON segment untouched', () => {
    const stage = createFuzzyDedupStage({ threshold: 0.5 });
    const json = JSON.stringify({ rows: [{ v: 'alpha' }, { v: 'alpha' }, { v: 'alpha' }] }, null, 2);

    const result = stage.execute([seg('a', json)], context);

    expect(result.segments[0].content).toBe(json);
  });

  it('caps the paragraph pool at maxItems and warns', () => {
    const stage = createFuzzyDedupStage({ maxItems: 2, threshold: 0.8 });
    const dupA = 'Multi-agent systems cost 5-10x more than single-agent setups in production today';
    const dupB = 'Multi-agent systems cost 5-10x more than single-agent setups in production now';
    const beyondCap = 'Local deployment improves data sovereignty and compliance for regulated enterprises.';
    const input = seg('a', `${dupA}\n\n${dupB}\n\n${beyondCap}`);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = stage.execute([input], context);

    expect(warnSpy).toHaveBeenCalledWith('context-engine: fuzzy dedup capped at 2 items (3 provided)');
    expect(result.segments[0].content).toContain(beyondCap);
    warnSpy.mockRestore();
  });
});
