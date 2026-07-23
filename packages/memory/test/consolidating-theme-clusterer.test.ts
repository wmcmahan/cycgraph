import { describe, it, expect } from 'vitest';
import { ConsolidatingThemeClusterer } from '../src/hierarchy/consolidating-theme-clusterer.js';
import type { SemanticFact } from '../src/schemas/semantic.js';
import type { Theme } from '../src/schemas/theme.js';
import { cosineSimilarity } from '../src/utils/similarity.js';

const now = new Date('2024-01-01T10:00:00Z');

function makeFact(content: string, embedding?: number[]): SemanticFact {
  return {
    id: crypto.randomUUID(),
    content,
    source_episode_ids: [],
    entity_ids: [],
    provenance: { source: 'derived', created_at: now },
    valid_from: now,
    embedding,
  };
}

function makeTheme(label: string, factIds: string[], embedding?: number[]): Theme {
  return {
    id: crypto.randomUUID(),
    label,
    description: '',
    fact_ids: factIds,
    embedding,
    provenance: { source: 'system', created_at: now },
  };
}

/** Create a unit vector in the given direction (for predictable cosine similarity). */
function unitVec(values: number[]): number[] {
  const mag = Math.sqrt(values.reduce((s, v) => s + v * v, 0));
  return values.map((v) => v / mag);
}

describe('ConsolidatingThemeClusterer', () => {
  it('assigns facts to existing themes when above threshold (same as SimpleThemeClusterer)', async () => {
    const clusterer = new ConsolidatingThemeClusterer({ assignmentThreshold: 0.7 });
    const theme = makeTheme('Architecture', [], [1, 0, 0]);
    const fact = makeFact('About architecture', [0.95, 0.1, 0.1]);
    const result = await clusterer.cluster([fact], [theme]);

    const arch = result.find((t) => t.label === 'Architecture');
    expect(arch).toBeDefined();
    expect(arch!.fact_ids).toContain(fact.id);
  });

  it('creates new theme when fact does not match any existing theme', async () => {
    const clusterer = new ConsolidatingThemeClusterer({ assignmentThreshold: 0.7 });
    const theme = makeTheme('Architecture', [], [1, 0, 0]);
    const fact = makeFact('About cooking', [0, 0, 1]);
    const result = await clusterer.cluster([fact], [theme]);

    expect(result.length).toBe(2);
    const newTheme = result.find((t) => t.label !== 'Architecture');
    expect(newTheme).toBeDefined();
    expect(newTheme!.fact_ids).toContain(fact.id);
  });

  it('merges two themes above merge threshold', async () => {
    const clusterer = new ConsolidatingThemeClusterer({ mergeThreshold: 0.85 });
    // Two very similar embeddings (cosine > 0.85)
    const emb1 = [1, 0, 0];
    const emb2 = [0.99, 0.1, 0];
    expect(cosineSimilarity(emb1, emb2)).toBeGreaterThan(0.85);

    const fact1 = makeFact('Fact A', emb1);
    const fact2 = makeFact('Fact B', emb2);
    const result = await clusterer.cluster([fact1, fact2]);

    // Should merge into one theme
    expect(result).toHaveLength(1);
    expect(result[0].fact_ids).toContain(fact1.id);
    expect(result[0].fact_ids).toContain(fact2.id);
  });

  it('keeps label of the larger theme after merge', async () => {
    const clusterer = new ConsolidatingThemeClusterer({ mergeThreshold: 0.85 });
    const f1 = makeFact('F1', [1, 0, 0]);
    const f2 = makeFact('F2', [1, 0, 0]);
    const f3 = makeFact('F3', [0.99, 0.1, 0]);

    // Create themes: one with 2 facts, one with 1
    const bigTheme = makeTheme('Big Theme', [f1.id, f2.id], [1, 0, 0]);
    const smallTheme = makeTheme('Small Theme', [f3.id], [0.99, 0.1, 0]);

    const result = await clusterer.cluster([], [bigTheme, smallTheme]);
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe('Big Theme');
  });

  it('merged theme has combined fact_ids', async () => {
    const clusterer = new ConsolidatingThemeClusterer({ mergeThreshold: 0.85 });
    const f1 = makeFact('F1', [1, 0, 0]);
    const f2 = makeFact('F2', [0.99, 0.1, 0]);

    const t1 = makeTheme('T1', [f1.id], [1, 0, 0]);
    const t2 = makeTheme('T2', [f2.id], [0.99, 0.1, 0]);

    const result = await clusterer.cluster([], [t1, t2]);
    expect(result).toHaveLength(1);
    expect(result[0].fact_ids).toContain(f1.id);
    expect(result[0].fact_ids).toContain(f2.id);
  });

  it('merged theme embedding is average of originals', async () => {
    const clusterer = new ConsolidatingThemeClusterer({ mergeThreshold: 0.85 });
    const emb1 = [1, 0, 0];
    const emb2 = [0.99, 0.1, 0];

    const t1 = makeTheme('T1', ['a'], emb1);
    const t2 = makeTheme('T2', ['b'], emb2);

    const result = await clusterer.cluster([], [t1, t2]);
    expect(result).toHaveLength(1);
    const avg = result[0].embedding!;
    expect(avg[0]).toBeCloseTo((1 + 0.99) / 2);
    expect(avg[1]).toBeCloseTo((0 + 0.1) / 2);
    expect(avg[2]).toBeCloseTo(0);
  });

  it('merged centroid is weighted by fact count (large theme is not dragged toward a singleton)', async () => {
    const clusterer = new ConsolidatingThemeClusterer({ mergeThreshold: 0.85 });
    const big = makeTheme('Big', ['a', 'b', 'c'], [1, 0, 0]);
    const small = makeTheme('Small', ['d'], [0.99, 0.1, 0]);

    const result = await clusterer.cluster([], [big, small]);
    expect(result).toHaveLength(1);
    const centroid = result[0].embedding!;
    // (3·[1,0,0] + 1·[0.99,0.1,0]) / 4 — not the unweighted midpoint.
    expect(centroid[0]).toBeCloseTo((3 * 1 + 0.99) / 4);
    expect(centroid[1]).toBeCloseTo((3 * 0 + 0.1) / 4);
    expect(centroid[2]).toBeCloseTo(0);
  });

  it('does not merge when below threshold', async () => {
    const clusterer = new ConsolidatingThemeClusterer({ mergeThreshold: 0.85 });
    // Orthogonal embeddings
    const t1 = makeTheme('T1', ['a'], [1, 0, 0]);
    const t2 = makeTheme('T2', ['b'], [0, 1, 0]);

    const result = await clusterer.cluster([], [t1, t2]);
    expect(result).toHaveLength(2);
  });

  it('converges: iterates until no more merges needed', async () => {
    const clusterer = new ConsolidatingThemeClusterer({ mergeThreshold: 0.85 });
    // Three similar themes that should all merge together
    const t1 = makeTheme('T1', ['a', 'b'], [1, 0, 0]);
    const t2 = makeTheme('T2', ['c'], [0.99, 0.05, 0]);
    const t3 = makeTheme('T3', ['d'], [0.98, 0.1, 0]);

    const result = await clusterer.cluster([], [t1, t2, t3]);
    expect(result).toHaveLength(1);
    expect(result[0].fact_ids).toHaveLength(4);
  });

  it('enforces maxThemes cap', async () => {
    const clusterer = new ConsolidatingThemeClusterer({
      mergeThreshold: 0.99, // High threshold so auto-merge doesn't happen
      maxThemes: 2,
    });
    const f1 = makeFact('F1', [1, 0, 0]);
    const f2 = makeFact('F2', [0.5, 0.5, 0]);
    const f3 = makeFact('F3', [0, 0, 1]);

    const result = await clusterer.cluster([f1, f2, f3]);
    expect(result.length).toBeLessThanOrEqual(2);
  });

  it('assigns facts without embeddings to General theme', async () => {
    const clusterer = new ConsolidatingThemeClusterer();
    const factWithEmb = makeFact('With embedding', [1, 0, 0]);
    const factWithout = makeFact('No embedding');

    const result = await clusterer.cluster([factWithEmb, factWithout]);
    const general = result.find((t) => t.label === 'General');
    expect(general).toBeDefined();
    expect(general!.fact_ids).toContain(factWithout.id);
  });

  it('returns empty themes for empty input', async () => {
    const clusterer = new ConsolidatingThemeClusterer();
    const result = await clusterer.cluster([]);
    expect(result).toHaveLength(0);
  });

  it('sets theme_id back-pointer on clustered facts', async () => {
    const clusterer = new ConsolidatingThemeClusterer();
    const fact = makeFact('Only fact', [1, 0, 0]);
    const result = await clusterer.cluster([fact]);
    expect(fact.theme_id).toBe(result[0].id);
  });

  it('facts point at the surviving theme after a merge', async () => {
    // Two near-identical directions so each fact seeds its own theme
    // (assignment threshold high) and the merge pass then combines them.
    const clusterer = new ConsolidatingThemeClusterer({
      assignmentThreshold: 0.999,
      mergeThreshold: 0.9,
    });
    const factA = makeFact('A', unitVec([1, 0.10, 0]));
    const factB = makeFact('B', unitVec([1, 0.12, 0]));

    const result = await clusterer.cluster([factA, factB]);
    expect(result).toHaveLength(1);
    expect(factA.theme_id).toBe(result[0].id);
    expect(factB.theme_id).toBe(result[0].id);
  });

  it('facts without embeddings get the General theme id', async () => {
    const clusterer = new ConsolidatingThemeClusterer();
    const factWithout = makeFact('No embedding here at all');
    const result = await clusterer.cluster([factWithout]);
    const general = result.find((t) => t.label === 'General');
    expect(factWithout.theme_id).toBe(general!.id);
  });

  it('single fact creates single theme', async () => {
    const clusterer = new ConsolidatingThemeClusterer();
    const fact = makeFact('Only fact', [1, 0, 0]);
    const result = await clusterer.cluster([fact]);
    expect(result).toHaveLength(1);
    expect(result[0].fact_ids).toEqual([fact.id]);
  });

  it('existing themes are reused when facts match', async () => {
    const clusterer = new ConsolidatingThemeClusterer({ assignmentThreshold: 0.7 });
    const existing = makeTheme('Existing', [], [1, 0, 0]);
    const fact = makeFact('New fact', [0.9, 0.1, 0]);

    const result = await clusterer.cluster([fact], [existing]);
    const found = result.find((t) => t.label === 'Existing');
    expect(found).toBeDefined();
    expect(found!.fact_ids).toContain(fact.id);
  });

  it('three similar themes all merge into one', async () => {
    const clusterer = new ConsolidatingThemeClusterer({ mergeThreshold: 0.85 });
    const t1 = makeTheme('T1', ['a'], [1, 0, 0]);
    const t2 = makeTheme('T2', ['b'], [0.99, 0.05, 0]);
    const t3 = makeTheme('T3', ['c'], [0.98, 0.1, 0]);

    const result = await clusterer.cluster([], [t1, t2, t3]);
    expect(result).toHaveLength(1);
    expect(result[0].fact_ids.sort()).toEqual(['a', 'b', 'c'].sort());
  });

  it('dissimilar themes are preserved separately', async () => {
    const clusterer = new ConsolidatingThemeClusterer({ mergeThreshold: 0.85 });
    const t1 = makeTheme('Architecture', ['a'], [1, 0, 0]);
    const t2 = makeTheme('Cooking', ['b'], [0, 1, 0]);
    const t3 = makeTheme('Music', ['c'], [0, 0, 1]);

    const result = await clusterer.cluster([], [t1, t2, t3]);
    expect(result).toHaveLength(3);
  });

  it('merge cascade: A merges with B, then AB merges with C', async () => {
    const clusterer = new ConsolidatingThemeClusterer({ mergeThreshold: 0.80 });
    // A and B are very similar; C is somewhat similar to the A+B average
    const emA = [1, 0, 0];
    const emB = [0.95, 0.15, 0]; // cos(A,B) ~ 0.988
    // After merge, avg = [0.975, 0.075, 0]
    const emC = [0.9, 0.2, 0]; // cos(avg, C) ~ 0.99

    const t1 = makeTheme('A', ['a1', 'a2'], emA);
    const t2 = makeTheme('B', ['b1'], emB);
    const t3 = makeTheme('C', ['c1'], emC);

    const result = await clusterer.cluster([], [t1, t2, t3]);
    expect(result).toHaveLength(1);
    expect(result[0].fact_ids).toHaveLength(4);
  });

  it('all facts without embeddings produces single General theme', async () => {
    const clusterer = new ConsolidatingThemeClusterer();
    const f1 = makeFact('Fact one');
    const f2 = makeFact('Fact two');

    const result = await clusterer.cluster([f1, f2]);
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe('General');
    expect(result[0].fact_ids).toHaveLength(2);
  });

  it('does not merge themes without embeddings', async () => {
    const clusterer = new ConsolidatingThemeClusterer({ mergeThreshold: 0.5 });
    const t1 = makeTheme('T1', ['a']);
    const t2 = makeTheme('T2', ['b']);

    const result = await clusterer.cluster([], [t1, t2]);
    expect(result).toHaveLength(2);
  });

  it('maxThemes with no embeddable themes does not crash', async () => {
    const clusterer = new ConsolidatingThemeClusterer({ maxThemes: 1 });
    const f1 = makeFact('Fact one');
    const f2 = makeFact('Fact two');

    // Should not throw even though it can't merge
    const result = await clusterer.cluster([f1, f2]);
    expect(result.length).toBeGreaterThanOrEqual(1);
  });

  it('maxThemes = 1 merges everything into one theme', async () => {
    const clusterer = new ConsolidatingThemeClusterer({
      mergeThreshold: 0.99,
      maxThemes: 1,
    });
    const f1 = makeFact('F1', [1, 0, 0]);
    const f2 = makeFact('F2', [0, 1, 0]);
    const f3 = makeFact('F3', [0, 0, 1]);

    const result = await clusterer.cluster([f1, f2, f3]);
    expect(result).toHaveLength(1);
    expect(result[0].fact_ids).toHaveLength(3);
  });
});
