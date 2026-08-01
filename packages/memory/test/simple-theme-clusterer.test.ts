/**
 * Tests for hierarchy/simple-theme-clusterer: greedy embedding-based theme
 * assignment with a General-theme fallback, plus the assignThemeIds back-pointer.
 */

import { describe, it, expect } from 'vitest';
import {
  SimpleThemeClusterer,
  assignThemeIds,
} from '../src/hierarchy/simple-theme-clusterer.js';
import { makeFact, makeTheme } from './helpers.js';
import type { SemanticFact } from '../src/schemas/semantic.js';
import type { Theme } from '../src/schemas/theme.js';

function fact(content: string, embedding?: number[]): SemanticFact {
  return makeFact({ content, embedding });
}

function theme(label: string, fact_ids: string[], embedding?: number[]): Theme {
  return makeTheme({ label, fact_ids, embedding });
}

describe('assignThemeIds', () => {
  it('writes the theme_id back-pointer for every fact in a theme', () => {
    const f = fact('Belongs to work');
    const work = theme('Work', [f.id]);

    assignThemeIds([f], [work]);

    expect(f.theme_id).toBe(work.id);
  });

  it('leaves theme_id unset for a fact absent from all themes', () => {
    const f = fact('Orphan');
    const unrelated = theme('Other', ['some-other-id']);

    assignThemeIds([f], [unrelated]);

    expect(f.theme_id).toBeUndefined();
  });
});

describe('SimpleThemeClusterer', () => {
  it('assigns a fact to a similar existing theme and sets its theme_id', async () => {
    const clusterer = new SimpleThemeClusterer({ similarityThreshold: 0.7 });
    const existing = theme('Direction X', [], [1, 0, 0]);
    const f = fact('Close to X', [0.95, 0.05, 0]);

    const result = await clusterer.cluster([f], [existing]);

    const found = result.find((t) => t.label === 'Direction X');
    expect(found!.fact_ids).toContain(f.id);
    expect(f.theme_id).toBe(existing.id);
  });

  it('creates a new theme for a dissimilar fact and sets its theme_id', async () => {
    const clusterer = new SimpleThemeClusterer({ similarityThreshold: 0.7 });
    const existing = theme('Direction X', [], [1, 0, 0]);
    const f = fact('Orthogonal', [0, 1, 0]);

    const result = await clusterer.cluster([f], [existing]);

    expect(result).toHaveLength(2);
    const created = result.find((t) => t.label !== 'Direction X');
    expect(f.theme_id).toBe(created!.id);
  });

  it('skips existing themes that lack an embedding during assignment', async () => {
    const clusterer = new SimpleThemeClusterer({ similarityThreshold: 0.7 });
    const legacy = theme('Legacy', ['x']);
    const embedded = theme('Direction X', [], [1, 0, 0]);
    const f = fact('Close to X', [0.95, 0.05, 0]);

    const result = await clusterer.cluster([f], [legacy, embedded]);

    const found = result.find((t) => t.label === 'Direction X');
    expect(found!.fact_ids).toContain(f.id);
    expect(f.theme_id).toBe(embedded.id);
  });

  it('assigns a fact to the closer of two embedded themes', async () => {
    const clusterer = new SimpleThemeClusterer({ similarityThreshold: 0.7 });
    const near = theme('Near', [], [1, 0, 0]);
    const far = theme('Far', [], [0, 1, 0]);
    const f = fact('Close to near', [0.9, 0.1, 0]);

    const result = await clusterer.cluster([f], [near, far]);

    expect(result.find((t) => t.label === 'Near')!.fact_ids).toContain(f.id);
    expect(f.theme_id).toBe(near.id);
  });

  it('reuses an existing General theme for embeddingless facts', async () => {
    const clusterer = new SimpleThemeClusterer();
    const existingGeneral = theme('General', ['x']);
    const f = fact('No embedding');

    const result = await clusterer.cluster([f], [existingGeneral]);

    const generals = result.filter((t) => t.label === 'General');
    expect(generals).toHaveLength(1);
    expect(generals[0].fact_ids).toContain(f.id);
  });

  it('creates a new theme when no existing theme carries an embedding', async () => {
    const clusterer = new SimpleThemeClusterer();
    const f = fact('First embedded fact', [1, 0, 0]);

    const result = await clusterer.cluster([f]);

    expect(result).toHaveLength(1);
    expect(result[0].fact_ids).toEqual([f.id]);
    expect(f.theme_id).toBe(result[0].id);
  });

  it('routes every embeddingless fact to a single General theme with its id', async () => {
    const clusterer = new SimpleThemeClusterer();
    const a = fact('No embedding A');
    const b = fact('No embedding B');

    const result = await clusterer.cluster([a, b]);

    const general = result.find((t) => t.label === 'General');
    expect(general!.fact_ids).toEqual([a.id, b.id]);
    expect(a.theme_id).toBe(general!.id);
    expect(b.theme_id).toBe(general!.id);
  });

  it('creates a General theme for embeddingless facts when existing themes are present', async () => {
    const clusterer = new SimpleThemeClusterer();
    const existing = theme('Existing', ['x']);
    const f = fact('No embedding');

    const result = await clusterer.cluster([f], [existing]);

    const general = result.find((t) => t.label === 'General');
    expect(general!.fact_ids).toContain(f.id);
    expect(f.theme_id).toBe(general!.id);
  });

  it('sends embeddingless facts in a mixed batch to a shared General theme', async () => {
    const clusterer = new SimpleThemeClusterer();
    const embedded = fact('Has embedding', [1, 0, 0]);
    const plainA = fact('No embedding A');
    const plainB = fact('No embedding B');

    const result = await clusterer.cluster([embedded, plainA, plainB]);

    const general = result.find((t) => t.label === 'General');
    expect(general!.fact_ids).toEqual([plainA.id, plainB.id]);
    expect(plainA.theme_id).toBe(general!.id);
    expect(plainB.theme_id).toBe(general!.id);
    expect(embedded.theme_id).not.toBe(general!.id);
  });
});
