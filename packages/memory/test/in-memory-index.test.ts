import { describe, it, expect, beforeEach, vi } from 'vitest';
import { InMemoryMemoryStore, InMemoryMemoryIndex, EmbeddingDimensionMismatchError, IN_MEMORY_INDEX_WARN_THRESHOLD } from '../src/index.js';
import type { Entity, SemanticFact, Theme, Provenance } from '../src/index.js';

const now = new Date();
const prov: Provenance = { source: 'system', created_at: now };

function makeEntity(embedding: number[]): Entity {
  return {
    id: crypto.randomUUID(),
    name: 'Test',
    entity_type: 'concept',
    attributes: {},
    embedding,
    provenance: prov,
    created_at: now,
    updated_at: now,
  };
}

function makeFact(embedding: number[]): SemanticFact {
  return {
    id: crypto.randomUUID(),
    content: 'Fact',
    source_episode_ids: [],
    entity_ids: [],
    embedding,
    provenance: prov,
    valid_from: now,
  };
}

function makeTheme(embedding: number[]): Theme {
  return {
    id: crypto.randomUUID(),
    label: 'Theme',
    description: '',
    fact_ids: [],
    embedding,
    provenance: prov,
  };
}

describe('InMemoryMemoryIndex', () => {
  let store: InMemoryMemoryStore;
  let index: InMemoryMemoryIndex;

  beforeEach(async () => {
    store = new InMemoryMemoryStore();
    index = new InMemoryMemoryIndex();
  });

  it('finds similar entities by embedding', async () => {
    const e1 = makeEntity([1, 0, 0]);
    const e2 = makeEntity([0, 1, 0]);
    const e3 = makeEntity([0.9, 0.1, 0]);

    await store.putEntity(e1);
    await store.putEntity(e2);
    await store.putEntity(e3);
    await index.rebuild(store);

    const results = await index.searchEntities([1, 0, 0], { minSimilarity: 0.8 });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].item.id).toBe(e1.id);
    expect(results[0].score).toBeCloseTo(1.0);
  });

  it('respects minSimilarity threshold', async () => {
    await store.putEntity(makeEntity([0, 1, 0]));
    await index.rebuild(store);

    const results = await index.searchEntities([1, 0, 0], { minSimilarity: 0.9 });
    expect(results).toHaveLength(0);
  });

  it('respects limit', async () => {
    for (let i = 0; i < 5; i++) {
      await store.putEntity(makeEntity([1, 0, i * 0.01]));
    }
    await index.rebuild(store);

    const results = await index.searchEntities([1, 0, 0], { limit: 2, minSimilarity: 0.5 });
    expect(results).toHaveLength(2);
  });

  it('searches facts by embedding', async () => {
    await store.putFact(makeFact([1, 0, 0]));
    await store.putFact(makeFact([0, 1, 0]));
    await index.rebuild(store);

    const results = await index.searchFacts([1, 0, 0], { minSimilarity: 0.9 });
    expect(results).toHaveLength(1);
  });

  it('searches themes by embedding', async () => {
    await store.putTheme(makeTheme([1, 0, 0]));
    await index.rebuild(store);

    const results = await index.searchThemes([1, 0, 0], { minSimilarity: 0.9 });
    expect(results).toHaveLength(1);
    expect(results[0].score).toBeCloseTo(1.0);
  });

  it('skips records without embeddings', async () => {
    const entityNoEmbed: Entity = {
      id: crypto.randomUUID(),
      name: 'No embed',
      entity_type: 'concept',
      attributes: {},
      provenance: prov,
      created_at: now,
      updated_at: now,
    };
    await store.putEntity(entityNoEmbed);
    await index.rebuild(store);

    const results = await index.searchEntities([1, 0, 0], { minSimilarity: 0 });
    expect(results).toHaveLength(0);
  });

  describe('expectedDimensions validation', () => {
    it('accepts queries that match the configured dimension', async () => {
      const dimIndex = new InMemoryMemoryIndex({ expectedDimensions: 3 });
      const dimStore = new InMemoryMemoryStore();
      await dimStore.putEntity(makeEntity([1, 0, 0]));
      await dimIndex.rebuild(dimStore);

      // Same dim — should not throw
      await expect(dimIndex.searchEntities([0, 1, 0])).resolves.toBeDefined();
    });

    it('throws EmbeddingDimensionMismatchError on a wrong-dim query', async () => {
      const dimIndex = new InMemoryMemoryIndex({ expectedDimensions: 1536 });
      const dimStore = new InMemoryMemoryStore();
      await dimIndex.rebuild(dimStore);

      // Query with 512 dims instead of 1536
      const badQuery = new Array(512).fill(0.1);
      await expect(dimIndex.searchEntities(badQuery)).rejects.toBeInstanceOf(EmbeddingDimensionMismatchError);
      await expect(dimIndex.searchFacts(badQuery)).rejects.toBeInstanceOf(EmbeddingDimensionMismatchError);
      await expect(dimIndex.searchThemes(badQuery)).rejects.toBeInstanceOf(EmbeddingDimensionMismatchError);
      await expect(dimIndex.searchEpisodes(badQuery)).rejects.toBeInstanceOf(EmbeddingDimensionMismatchError);
    });

    it('a failed rebuild leaves the previous index snapshot intact', async () => {
      const idx = new InMemoryMemoryIndex({ expectedDimensions: 3 });
      const goodEntity = makeEntity([1, 0, 0]);
      await store.putEntity(goodEntity);
      await idx.rebuild(store);

      // Second rebuild fails on a bad-dimension fact — entities were fetched
      // (and would have been assigned first, pre-fix), facts throw.
      const newEntity = makeEntity([0, 1, 0]);
      await store.putEntity(newEntity);
      await store.putFact(makeFact([1, 2])); // wrong dims
      await expect(idx.rebuild(store)).rejects.toThrow(EmbeddingDimensionMismatchError);

      // The index still serves the first (consistent) snapshot: the old
      // entity is findable, the new one is not.
      const results = await idx.searchEntities([1, 0, 0], { minSimilarity: 0, limit: 10 });
      const ids = results.map((r) => r.item.id);
      expect(ids).toContain(goodEntity.id);
      expect(ids).not.toContain(newEntity.id);
    });

    it('throws when rebuild encounters a stored embedding with mismatched dim', async () => {
      // 1536-dim configured, but underlying store has a 3-dim entity left over
      // from before a provider swap. This simulates schema drift.
      const dimIndex = new InMemoryMemoryIndex({ expectedDimensions: 1536 });
      const dimStore = new InMemoryMemoryStore();
      await dimStore.putEntity(makeEntity([1, 0, 0])); // wrong dim

      await expect(dimIndex.rebuild(dimStore)).rejects.toBeInstanceOf(EmbeddingDimensionMismatchError);
    });

    it('exposes expected/actual on the thrown error for debugging', async () => {
      const dimIndex = new InMemoryMemoryIndex({ expectedDimensions: 1536 });
      const dimStore = new InMemoryMemoryStore();
      await dimIndex.rebuild(dimStore);

      try {
        await dimIndex.searchEntities([1, 2, 3]);
        throw new Error('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(EmbeddingDimensionMismatchError);
        const mismatch = err as EmbeddingDimensionMismatchError;
        expect(mismatch.expected).toBe(1536);
        expect(mismatch.actual).toBe(3);
        expect(mismatch.context).toBe('searchEntities');
      }
    });

    it('does no validation when expectedDimensions is unset (backwards compatible)', async () => {
      // Default-constructed index — no expectedDimensions, no validation.
      const plainIndex = new InMemoryMemoryIndex();
      const plainStore = new InMemoryMemoryStore();
      await plainStore.putEntity(makeEntity([1, 0, 0]));
      await plainIndex.rebuild(plainStore);

      // 512-dim query against 3-dim store still resolves (returns 0 matches
      // via cosine-similarity short-circuit) — no throw.
      const badQuery = new Array(512).fill(0.1);
      await expect(plainIndex.searchEntities(badQuery)).resolves.toBeDefined();
    });
  });

  describe('rebuild truncation warning', () => {
    it('warns explicitly when a record type exceeds the indexing cap', async () => {
      const bigStore = new InMemoryMemoryStore();
      for (let i = 0; i <= IN_MEMORY_INDEX_WARN_THRESHOLD; i++) {
        await bigStore.putFact(makeFact([1, 0, 0]));
      }

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const bigIndex = new InMemoryMemoryIndex();
      await bigIndex.rebuild(bigStore);

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toMatch(/NOT indexed/);

      // One-shot: a second rebuild does not warn again.
      await bigIndex.rebuild(bigStore);
      expect(warnSpy).toHaveBeenCalledTimes(1);

      // The index holds exactly the cap, not the full store.
      const results = await bigIndex.searchFacts([1, 0, 0], { limit: 100, minSimilarity: 0 });
      expect(results.length).toBe(100); // search still works on the capped index
      warnSpy.mockRestore();
    });

    it('silenceScaleWarning suppresses the truncation warning too', async () => {
      const bigStore = new InMemoryMemoryStore();
      for (let i = 0; i <= IN_MEMORY_INDEX_WARN_THRESHOLD; i++) {
        await bigStore.putFact(makeFact([1, 0, 0]));
      }

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const quietIndex = new InMemoryMemoryIndex({ silenceScaleWarning: true });
      await quietIndex.rebuild(bigStore);

      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });
});
