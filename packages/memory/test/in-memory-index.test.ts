/**
 * Unit tests for InMemoryMemoryIndex — the brute-force cosine similarity index.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  InMemoryMemoryStore,
  InMemoryMemoryIndex,
  EmbeddingDimensionMismatchError,
  IN_MEMORY_INDEX_WARN_THRESHOLD,
} from '../src/index.js';
import { makeEntity, makeFact, makeTheme, makeEpisode } from './helpers.js';

describe('InMemoryMemoryIndex', () => {
  let store: InMemoryMemoryStore;
  let index: InMemoryMemoryIndex;

  beforeEach(() => {
    store = new InMemoryMemoryStore();
    index = new InMemoryMemoryIndex();
  });

  describe('search', () => {
    it('ranks entities by cosine similarity to the query', async () => {
      const e1 = makeEntity({ embedding: [1, 0, 0] });
      const e2 = makeEntity({ embedding: [0, 1, 0] });
      const e3 = makeEntity({ embedding: [0.9, 0.1, 0] });
      await store.putEntity(e1);
      await store.putEntity(e2);
      await store.putEntity(e3);
      await index.rebuild(store);

      const results = await index.searchEntities([1, 0, 0], { minSimilarity: 0.8 });

      expect(results[0].item.id).toBe(e1.id);
      expect(results[0].score).toBeCloseTo(1.0);
    });

    it('drops results below minSimilarity', async () => {
      await store.putEntity(makeEntity({ embedding: [0, 1, 0] }));
      await index.rebuild(store);

      const results = await index.searchEntities([1, 0, 0], { minSimilarity: 0.9 });

      expect(results).toHaveLength(0);
    });

    it('caps results at the requested limit', async () => {
      for (let i = 0; i < 5; i++) {
        await store.putEntity(makeEntity({ embedding: [1, 0, i * 0.01] }));
      }
      await index.rebuild(store);

      const results = await index.searchEntities([1, 0, 0], { limit: 2, minSimilarity: 0.5 });

      expect(results).toHaveLength(2);
    });

    it('searches facts by embedding', async () => {
      await store.putFact(makeFact({ embedding: [1, 0, 0] }));
      await store.putFact(makeFact({ embedding: [0, 1, 0] }));
      await index.rebuild(store);

      const results = await index.searchFacts([1, 0, 0], { minSimilarity: 0.9 });

      expect(results).toHaveLength(1);
    });

    it('searches themes by embedding', async () => {
      await store.putTheme(makeTheme({ embedding: [1, 0, 0] }));
      await index.rebuild(store);

      const results = await index.searchThemes([1, 0, 0], { minSimilarity: 0.9 });

      expect(results).toHaveLength(1);
      expect(results[0].score).toBeCloseTo(1.0);
    });

    it('searches episodes by embedding', async () => {
      await store.putEpisode(makeEpisode({ embedding: [1, 0, 0] }));
      await index.rebuild(store);

      const results = await index.searchEpisodes([1, 0, 0], { minSimilarity: 0.9 });

      expect(results).toHaveLength(1);
      expect(results[0].score).toBeCloseTo(1.0);
    });

    it('skips records that carry no embedding', async () => {
      await store.putEntity(makeEntity());
      await index.rebuild(store);

      const results = await index.searchEntities([1, 0, 0], { minSimilarity: 0 });

      expect(results).toHaveLength(0);
    });
  });

  describe('expectedDimensions validation', () => {
    it('accepts a query matching the configured dimension', async () => {
      const dimIndex = new InMemoryMemoryIndex({ expectedDimensions: 3 });
      await store.putEntity(makeEntity({ embedding: [1, 0, 0] }));
      await dimIndex.rebuild(store);

      await expect(dimIndex.searchEntities([0, 1, 0])).resolves.toBeDefined();
    });

    it('throws on a wrong-dimension query across every search method', async () => {
      const dimIndex = new InMemoryMemoryIndex({ expectedDimensions: 1536 });
      await dimIndex.rebuild(store);
      const badQuery = new Array(512).fill(0.1);

      await expect(dimIndex.searchEntities(badQuery)).rejects.toBeInstanceOf(EmbeddingDimensionMismatchError);
      await expect(dimIndex.searchFacts(badQuery)).rejects.toBeInstanceOf(EmbeddingDimensionMismatchError);
      await expect(dimIndex.searchThemes(badQuery)).rejects.toBeInstanceOf(EmbeddingDimensionMismatchError);
      await expect(dimIndex.searchEpisodes(badQuery)).rejects.toBeInstanceOf(EmbeddingDimensionMismatchError);
    });

    it('throws when rebuild meets a stored embedding of the wrong dimension', async () => {
      const dimIndex = new InMemoryMemoryIndex({ expectedDimensions: 1536 });
      await store.putEntity(makeEntity({ embedding: [1, 0, 0] }));

      await expect(dimIndex.rebuild(store)).rejects.toBeInstanceOf(EmbeddingDimensionMismatchError);
    });

    it('keeps the previous snapshot live when a rebuild throws partway through', async () => {
      const dimIndex = new InMemoryMemoryIndex({ expectedDimensions: 3 });
      const goodEntity = makeEntity({ embedding: [1, 0, 0] });
      await store.putEntity(goodEntity);
      await dimIndex.rebuild(store);

      const newEntity = makeEntity({ embedding: [0, 1, 0] });
      await store.putEntity(newEntity);
      await store.putFact(makeFact({ embedding: [1, 2] }));
      await expect(dimIndex.rebuild(store)).rejects.toThrow(EmbeddingDimensionMismatchError);

      const ids = (await dimIndex.searchEntities([1, 0, 0], { minSimilarity: 0, limit: 10 })).map((r) => r.item.id);
      expect(ids).toContain(goodEntity.id);
      expect(ids).not.toContain(newEntity.id);
    });

    it('exposes expected, actual and context on the thrown error', async () => {
      const dimIndex = new InMemoryMemoryIndex({ expectedDimensions: 1536 });
      await dimIndex.rebuild(store);

      const error = await dimIndex
        .searchEntities([1, 2, 3])
        .catch((err) => err as EmbeddingDimensionMismatchError);

      expect(error).toBeInstanceOf(EmbeddingDimensionMismatchError);
      expect(error.expected).toBe(1536);
      expect(error.actual).toBe(3);
      expect(error.context).toBe('searchEntities');
    });

    it('performs no validation when expectedDimensions is unset', async () => {
      await store.putEntity(makeEntity({ embedding: [1, 0, 0] }));
      await index.rebuild(store);
      const badQuery = new Array(512).fill(0.1);

      await expect(index.searchEntities(badQuery)).resolves.toBeDefined();
    });
  });

  describe('scale warning', () => {
    it('warns once when the indexed total crosses the threshold without truncation', async () => {
      const bigStore = new InMemoryMemoryStore();
      for (let i = 0; i < IN_MEMORY_INDEX_WARN_THRESHOLD; i++) {
        await bigStore.putFact(makeFact({ embedding: [1, 0, 0] }));
      }
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const bigIndex = new InMemoryMemoryIndex();

      await bigIndex.rebuild(bigStore);
      await bigIndex.rebuild(bigStore);

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toMatch(/embeddings/);
      warnSpy.mockRestore();
    });

    it('warns explicitly when a record type exceeds the indexing cap', async () => {
      const bigStore = new InMemoryMemoryStore();
      for (let i = 0; i <= IN_MEMORY_INDEX_WARN_THRESHOLD; i++) {
        await bigStore.putFact(makeFact({ embedding: [1, 0, 0] }));
      }
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const bigIndex = new InMemoryMemoryIndex();

      await bigIndex.rebuild(bigStore);

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toMatch(/NOT indexed/);

      await bigIndex.rebuild(bigStore);
      expect(warnSpy).toHaveBeenCalledTimes(1);

      const results = await bigIndex.searchFacts([1, 0, 0], { limit: 100, minSimilarity: 0 });
      expect(results).toHaveLength(100);
      warnSpy.mockRestore();
    });

    it('silenceScaleWarning suppresses the truncation warning', async () => {
      const bigStore = new InMemoryMemoryStore();
      for (let i = 0; i <= IN_MEMORY_INDEX_WARN_THRESHOLD; i++) {
        await bigStore.putFact(makeFact({ embedding: [1, 0, 0] }));
      }
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const quietIndex = new InMemoryMemoryIndex({ silenceScaleWarning: true });

      await quietIndex.rebuild(bigStore);

      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });
});
