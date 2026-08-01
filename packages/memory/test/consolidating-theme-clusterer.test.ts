/**
 * Tests for hierarchy/consolidating-theme-clusterer: two-pass clustering
 * (greedy assignment then a merge pass) with a maxThemes cap, an embeddingless
 * General fallback, and fact-count-weighted centroid merging.
 */

import { describe, it, expect } from 'vitest';
import { ConsolidatingThemeClusterer } from '../src/hierarchy/consolidating-theme-clusterer.js';
import { cosineSimilarity } from '../src/utils/similarity.js';
import { makeFact, makeTheme } from './helpers.js';
import type { SemanticFact } from '../src/schemas/semantic.js';
import type { Theme } from '../src/schemas/theme.js';

function fact(content: string, embedding?: number[]): SemanticFact {
  return makeFact({ content, embedding });
}

function theme(label: string, fact_ids: string[], embedding?: number[]): Theme {
  return makeTheme({ label, fact_ids, embedding });
}

function unitVec(values: number[]): number[] {
  const mag = Math.sqrt(values.reduce((s, v) => s + v * v, 0));
  return values.map((v) => v / mag);
}

describe('ConsolidatingThemeClusterer', () => {
  describe('greedy assignment', () => {
    it('assigns a fact to an existing theme above the assignment threshold', async () => {
      const clusterer = new ConsolidatingThemeClusterer({ assignmentThreshold: 0.7 });
      const existing = theme('Architecture', [], [1, 0, 0]);
      const f = fact('About architecture', [0.95, 0.1, 0.1]);

      const result = await clusterer.cluster([f], [existing]);

      const arch = result.find((t) => t.label === 'Architecture');
      expect(arch!.fact_ids).toContain(f.id);
    });

    it('skips existing themes that lack an embedding during assignment', async () => {
      const clusterer = new ConsolidatingThemeClusterer({ assignmentThreshold: 0.7 });
      const legacy = theme('Legacy', ['x']);
      const embedded = theme('Architecture', [], [1, 0, 0]);
      const f = fact('About architecture', [0.95, 0.1, 0.1]);

      const result = await clusterer.cluster([f], [legacy, embedded]);

      const arch = result.find((t) => t.label === 'Architecture');
      expect(arch!.fact_ids).toContain(f.id);
    });

    it('creates a new theme when a fact matches no existing theme', async () => {
      const clusterer = new ConsolidatingThemeClusterer({ assignmentThreshold: 0.7 });
      const existing = theme('Architecture', [], [1, 0, 0]);
      const f = fact('About cooking', [0, 0, 1]);

      const result = await clusterer.cluster([f], [existing]);

      expect(result).toHaveLength(2);
      const created = result.find((t) => t.label !== 'Architecture');
      expect(created!.fact_ids).toContain(f.id);
    });

    it('seeds a single theme from a single embedded fact', async () => {
      const clusterer = new ConsolidatingThemeClusterer();
      const f = fact('Only fact', [1, 0, 0]);

      const result = await clusterer.cluster([f]);

      expect(result).toHaveLength(1);
      expect(result[0].fact_ids).toEqual([f.id]);
    });

    it('returns no themes for empty input', async () => {
      const clusterer = new ConsolidatingThemeClusterer();

      const result = await clusterer.cluster([]);

      expect(result).toHaveLength(0);
    });
  });

  describe('merge pass', () => {
    it('merges two themes whose similarity is above the merge threshold', async () => {
      const clusterer = new ConsolidatingThemeClusterer({ mergeThreshold: 0.85 });
      const embA = [1, 0, 0];
      const embB = [0.99, 0.1, 0];
      expect(cosineSimilarity(embA, embB)).toBeGreaterThan(0.85);
      const f1 = fact('Fact A', embA);
      const f2 = fact('Fact B', embB);

      const result = await clusterer.cluster([f1, f2]);

      expect(result).toHaveLength(1);
      expect(result[0].fact_ids).toContain(f1.id);
      expect(result[0].fact_ids).toContain(f2.id);
    });

    it('keeps the label and combined fact_ids of the larger theme after a merge', async () => {
      const clusterer = new ConsolidatingThemeClusterer({ mergeThreshold: 0.85 });
      const big = theme('Big Theme', ['a', 'b'], [1, 0, 0]);
      const small = theme('Small Theme', ['c'], [0.99, 0.1, 0]);

      const result = await clusterer.cluster([], [big, small]);

      expect(result).toHaveLength(1);
      expect(result[0].label).toBe('Big Theme');
      expect(result[0].fact_ids.sort()).toEqual(['a', 'b', 'c']);
    });

    it('keeps the larger theme when it is the second of the merged pair', async () => {
      const clusterer = new ConsolidatingThemeClusterer({ mergeThreshold: 0.85 });
      const small = theme('Small Theme', ['a'], [1, 0, 0]);
      const big = theme('Big Theme', ['b', 'c'], [0.99, 0.1, 0]);

      const result = await clusterer.cluster([], [small, big]);

      expect(result).toHaveLength(1);
      expect(result[0].label).toBe('Big Theme');
      expect(result[0].fact_ids.sort()).toEqual(['a', 'b', 'c']);
    });

    it('does not merge themes below the merge threshold', async () => {
      const clusterer = new ConsolidatingThemeClusterer({ mergeThreshold: 0.85 });
      const t1 = theme('T1', ['a'], [1, 0, 0]);
      const t2 = theme('T2', ['b'], [0, 1, 0]);

      const result = await clusterer.cluster([], [t1, t2]);

      expect(result).toHaveLength(2);
    });

    it('does not merge themes that lack embeddings', async () => {
      const clusterer = new ConsolidatingThemeClusterer({ mergeThreshold: 0.5 });
      const t1 = theme('T1', ['a']);
      const t2 = theme('T2', ['b']);

      const result = await clusterer.cluster([], [t1, t2]);

      expect(result).toHaveLength(2);
    });

    it('converges when a chain of similar themes all collapse into one', async () => {
      const clusterer = new ConsolidatingThemeClusterer({ mergeThreshold: 0.85 });
      const t1 = theme('T1', ['a', 'b'], [1, 0, 0]);
      const t2 = theme('T2', ['c'], [0.99, 0.05, 0]);
      const t3 = theme('T3', ['d'], [0.98, 0.1, 0]);

      const result = await clusterer.cluster([], [t1, t2, t3]);

      expect(result).toHaveLength(1);
      expect(result[0].fact_ids).toHaveLength(4);
    });

    it('cascades a merge: A joins B, then AB absorbs C via the updated centroid', async () => {
      const clusterer = new ConsolidatingThemeClusterer({ mergeThreshold: 0.8 });
      const t1 = theme('A', ['a1', 'a2'], [1, 0, 0]);
      const t2 = theme('B', ['b1'], [0.95, 0.15, 0]);
      const t3 = theme('C', ['c1'], [0.9, 0.2, 0]);

      const result = await clusterer.cluster([], [t1, t2, t3]);

      expect(result).toHaveLength(1);
      expect(result[0].fact_ids).toHaveLength(4);
    });

    it('preserves dissimilar themes as separate clusters', async () => {
      const clusterer = new ConsolidatingThemeClusterer({ mergeThreshold: 0.85 });
      const t1 = theme('Architecture', ['a'], [1, 0, 0]);
      const t2 = theme('Cooking', ['b'], [0, 1, 0]);
      const t3 = theme('Music', ['c'], [0, 0, 1]);

      const result = await clusterer.cluster([], [t1, t2, t3]);

      expect(result).toHaveLength(3);
    });
  });

  describe('maxThemes cap', () => {
    it('reduces the theme count to the cap by merging the most similar pairs', async () => {
      const clusterer = new ConsolidatingThemeClusterer({ mergeThreshold: 0.99, maxThemes: 2 });
      const f1 = fact('F1', [1, 0, 0]);
      const f2 = fact('F2', [0.5, 0.5, 0]);
      const f3 = fact('F3', [0, 0, 1]);

      const result = await clusterer.cluster([f1, f2, f3]);

      expect(result).toHaveLength(2);
    });

    it('merges everything into one theme when the cap is one', async () => {
      const clusterer = new ConsolidatingThemeClusterer({ mergeThreshold: 0.99, maxThemes: 1 });
      const f1 = fact('F1', [1, 0, 0]);
      const f2 = fact('F2', [0, 1, 0]);
      const f3 = fact('F3', [0, 0, 1]);

      const result = await clusterer.cluster([f1, f2, f3]);

      expect(result).toHaveLength(1);
      expect(result[0].fact_ids).toHaveLength(3);
    });

    it('stops cap enforcement when no embeddable pair remains to merge', async () => {
      const clusterer = new ConsolidatingThemeClusterer({ maxThemes: 1 });
      const t1 = theme('T1', ['a']);
      const t2 = theme('T2', ['b']);

      const result = await clusterer.cluster([], [t1, t2]);

      expect(result).toHaveLength(2);
    });

    it('keeps the larger theme when the cap merges a small-then-big pair', async () => {
      const clusterer = new ConsolidatingThemeClusterer({ mergeThreshold: 0.99, maxThemes: 1 });
      const small = theme('Small', ['a'], [1, 0, 0]);
      const big = theme('Big', ['b', 'c'], [0, 1, 0]);

      const result = await clusterer.cluster([], [small, big]);

      expect(result).toHaveLength(1);
      expect(result[0].label).toBe('Big');
      expect(result[0].fact_ids.sort()).toEqual(['a', 'b', 'c']);
    });
  });

  describe('embeddingless fallback', () => {
    it('collapses a fully embeddingless batch into one General theme', async () => {
      const clusterer = new ConsolidatingThemeClusterer();
      const f1 = fact('Fact one');
      const f2 = fact('Fact two');

      const result = await clusterer.cluster([f1, f2]);

      expect(result).toHaveLength(1);
      expect(result[0].label).toBe('General');
      expect(result[0].fact_ids).toHaveLength(2);
    });

    it('creates a General theme for an embeddingless batch alongside existing themes', async () => {
      const clusterer = new ConsolidatingThemeClusterer();
      const existing = theme('Existing', ['x']);
      const f = fact('No embedding');

      const result = await clusterer.cluster([f], [existing]);

      const general = result.find((t) => t.label === 'General');
      expect(general!.fact_ids).toContain(f.id);
    });

    it('reuses an existing General theme for an embeddingless batch', async () => {
      const clusterer = new ConsolidatingThemeClusterer();
      const existingGeneral = theme('General', ['x']);
      const f = fact('No embedding');

      const result = await clusterer.cluster([f], [existingGeneral]);

      const generals = result.filter((t) => t.label === 'General');
      expect(generals).toHaveLength(1);
      expect(generals[0].fact_ids).toContain(f.id);
    });

    it('shares one General theme among multiple embeddingless facts in a mixed batch', async () => {
      const clusterer = new ConsolidatingThemeClusterer();
      const embedded = fact('With embedding', [1, 0, 0]);
      const plainA = fact('Plain one');
      const plainB = fact('Plain two');

      const result = await clusterer.cluster([embedded, plainA, plainB]);

      const general = result.find((t) => t.label === 'General');
      expect(general!.fact_ids).toEqual([plainA.id, plainB.id]);
    });

    it('routes a lone embeddingless fact in a mixed batch to a General theme', async () => {
      const clusterer = new ConsolidatingThemeClusterer();
      const embedded = fact('With embedding', [1, 0, 0]);
      const plain = fact('No embedding');

      const result = await clusterer.cluster([embedded, plain]);

      const general = result.find((t) => t.label === 'General');
      expect(general!.fact_ids).toContain(plain.id);
    });
  });

  describe('theme_id back-pointers', () => {
    it('sets theme_id on a clustered fact', async () => {
      const clusterer = new ConsolidatingThemeClusterer();
      const f = fact('Only fact', [1, 0, 0]);

      const result = await clusterer.cluster([f]);

      expect(f.theme_id).toBe(result[0].id);
    });

    it('points merged-away facts at the surviving theme', async () => {
      const clusterer = new ConsolidatingThemeClusterer({
        assignmentThreshold: 0.999,
        mergeThreshold: 0.9,
      });
      const a = fact('A', unitVec([1, 0.1, 0]));
      const b = fact('B', unitVec([1, 0.12, 0]));

      const result = await clusterer.cluster([a, b]);

      expect(result).toHaveLength(1);
      expect(a.theme_id).toBe(result[0].id);
      expect(b.theme_id).toBe(result[0].id);
    });

    it('gives an embeddingless fact the General theme id', async () => {
      const clusterer = new ConsolidatingThemeClusterer();
      const f = fact('No embedding here at all');

      const result = await clusterer.cluster([f]);

      const general = result.find((t) => t.label === 'General');
      expect(f.theme_id).toBe(general!.id);
    });
  });

  describe('centroid merging', () => {
    it('averages two equal-sized centroids', async () => {
      const clusterer = new ConsolidatingThemeClusterer({ mergeThreshold: 0.85 });
      const t1 = theme('T1', ['a'], [1, 0, 0]);
      const t2 = theme('T2', ['b'], [0.99, 0.1, 0]);

      const result = await clusterer.cluster([], [t1, t2]);

      const centroid = result[0].embedding!;
      expect(centroid[0]).toBeCloseTo((1 + 0.99) / 2);
      expect(centroid[1]).toBeCloseTo((0 + 0.1) / 2);
      expect(centroid[2]).toBeCloseTo(0);
    });

    it('weights the merged centroid by fact count so a big theme resists a singleton', async () => {
      const clusterer = new ConsolidatingThemeClusterer({ mergeThreshold: 0.85 });
      const big = theme('Big', ['a', 'b', 'c'], [1, 0, 0]);
      const small = theme('Small', ['d'], [0.99, 0.1, 0]);

      const result = await clusterer.cluster([], [big, small]);

      const centroid = result[0].embedding!;
      expect(centroid[0]).toBeCloseTo((3 * 1 + 0.99) / 4);
      expect(centroid[1]).toBeCloseTo((3 * 0 + 0.1) / 4);
      expect(centroid[2]).toBeCloseTo(0);
    });

    it('averages centroids when both merged themes have zero facts', async () => {
      const clusterer = new ConsolidatingThemeClusterer({ mergeThreshold: 0.85 });
      const t1 = theme('T1', [], [1, 0, 0]);
      const t2 = theme('T2', [], [1, 0, 0]);

      const result = await clusterer.cluster([], [t1, t2]);

      expect(result).toHaveLength(1);
      expect(result[0].embedding).toEqual([1, 0, 0]);
    });

    it('keeps the wider embedding when a forced merge hits mismatched dimensions', async () => {
      const clusterer = new ConsolidatingThemeClusterer({ mergeThreshold: 0.99, maxThemes: 1 });
      const wide = theme('Wide', ['a', 'b'], [1, 0, 0]);
      const narrow = theme('Narrow', ['c'], [1, 0]);

      const result = await clusterer.cluster([], [wide, narrow]);

      expect(result).toHaveLength(1);
      expect(result[0].label).toBe('Wide');
      expect(result[0].embedding).toEqual([1, 0, 0]);
    });

    it('adopts the smaller theme embedding when the survivor is narrower on a mismatched merge', async () => {
      const clusterer = new ConsolidatingThemeClusterer({ mergeThreshold: 0.99, maxThemes: 1 });
      const bigNarrow = theme('BigNarrow', ['a', 'b'], [1, 0]);
      const smallWide = theme('SmallWide', ['c'], [1, 0, 0]);

      const result = await clusterer.cluster([], [bigNarrow, smallWide]);

      expect(result).toHaveLength(1);
      expect(result[0].label).toBe('BigNarrow');
      expect(result[0].embedding).toEqual([1, 0, 0]);
    });
  });
});
