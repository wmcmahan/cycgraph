import { describe, it, expect } from 'vitest';
import { SimpleThemeClusterer } from '../src/hierarchy/simple-theme-clusterer.js';
import type { SemanticFact } from '../src/schemas/semantic.js';
import type { Theme } from '../src/schemas/theme.js';

const now = new Date('2024-01-01T10:00:00Z');

function makeFact(content: string, embedding?: number[]): SemanticFact {
  return {
    id: crypto.randomUUID(),
    content,
    source_episode_ids: [],
    entity_ids: [],
    provenance: { source: 'derived', created_at: now },
    valid_from: now,
    tags: [],
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

describe('SimpleThemeClusterer', () => {
  it('assigns a fact to a similar existing theme and sets its theme_id', async () => {
    const clusterer = new SimpleThemeClusterer({ similarityThreshold: 0.7 });
    const existing = makeTheme('Direction X', [], [1, 0, 0]);
    const fact = makeFact('Close to X', [0.95, 0.05, 0]);

    const result = await clusterer.cluster([fact], [existing]);
    const theme = result.find((t) => t.label === 'Direction X');
    expect(theme!.fact_ids).toContain(fact.id);
    expect(fact.theme_id).toBe(existing.id);
  });

  it('creates a new theme for a dissimilar fact and sets its theme_id', async () => {
    const clusterer = new SimpleThemeClusterer({ similarityThreshold: 0.7 });
    const existing = makeTheme('Direction X', [], [1, 0, 0]);
    const fact = makeFact('Orthogonal', [0, 1, 0]);

    const result = await clusterer.cluster([fact], [existing]);
    expect(result).toHaveLength(2);
    const newTheme = result.find((t) => t.label !== 'Direction X');
    expect(fact.theme_id).toBe(newTheme!.id);
  });

  it('facts without embeddings land in the General theme with its id', async () => {
    const clusterer = new SimpleThemeClusterer();
    const fact = makeFact('No embedding');

    const result = await clusterer.cluster([fact]);
    const general = result.find((t) => t.label === 'General');
    expect(general!.fact_ids).toContain(fact.id);
    expect(fact.theme_id).toBe(general!.id);
  });
});
