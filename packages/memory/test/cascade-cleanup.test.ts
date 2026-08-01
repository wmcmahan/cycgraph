/**
 * Tests for MemoryConsolidator's theme cascade cleanup: when facts are
 * deduped or decayed, the themes referencing them are shrunk, re-centroided,
 * or removed.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryMemoryStore } from '../src/store/in-memory-store.js';
import { InMemoryMemoryIndex } from '../src/search/in-memory-index.js';
import { MemoryConsolidator } from '../src/consolidation/memory-consolidator.js';
import { makeFact, makeTheme } from './helpers.js';

function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

describe('MemoryConsolidator', () => {
  let store: InMemoryMemoryStore;
  let index: InMemoryMemoryIndex;

  beforeEach(() => {
    store = new InMemoryMemoryStore();
    index = new InMemoryMemoryIndex();
  });

  describe('theme cascade cleanup', () => {
    it('shrinks theme fact_ids when one fact is deduped', async () => {
      const f1 = makeFact({ content: 'Fact A', embedding: [1, 0, 0] });
      const f2 = makeFact({ content: 'Fact A similar', embedding: [0.99, 0.1, 0] });
      const f3 = makeFact({ content: 'Fact C', embedding: [0, 0, 1] });
      await store.putFact(f1);
      await store.putFact(f2);
      await store.putFact(f3);

      const theme = makeTheme({ fact_ids: [f1.id, f2.id, f3.id] });
      await store.putTheme(theme);
      await index.rebuild(store);

      const consolidator = new MemoryConsolidator(store, index, { dedupThreshold: 0.9 });
      const report = await consolidator.consolidate();

      expect(report.factsDeduped).toBe(1);
      expect(report.themesCleanedUp).toBe(1);
      const updated = await store.getTheme(theme.id);
      expect(updated).not.toBeNull();
      expect(updated!.fact_ids).toHaveLength(2);
    });

    it('deletes a theme when all its facts are pruned by decay', async () => {
      const f1 = makeFact({ content: 'Old 1', valid_from: daysAgo(90), access_count: 0, embedding: [1, 0, 0] });
      const f2 = makeFact({ content: 'Old 2', valid_from: daysAgo(80), access_count: 0, embedding: [0, 1, 0] });
      const keeper = makeFact({ content: 'Fresh', valid_from: daysAgo(1), access_count: 10, embedding: [0, 0, 1] });
      await store.putFact(f1);
      await store.putFact(f2);
      await store.putFact(keeper);

      const theme = makeTheme({ fact_ids: [f1.id, f2.id] });
      await store.putTheme(theme);

      const consolidator = new MemoryConsolidator(store, index, { maxFacts: 1, decayHalfLifeDays: 30 });
      const report = await consolidator.consolidate();

      expect(report.themesRemoved).toBe(1);
      const deleted = await store.getTheme(theme.id);
      expect(deleted).toBeNull();
    });

    it('recomputes the theme embedding as the centroid of remaining facts', async () => {
      const f1 = makeFact({ content: 'A', embedding: [1, 0, 0] });
      const f2 = makeFact({ content: 'A dup', embedding: [0.99, 0.1, 0] });
      const f3 = makeFact({ content: 'B', embedding: [0, 1, 0] });
      await store.putFact(f1);
      await store.putFact(f2);
      await store.putFact(f3);

      const theme = makeTheme({ fact_ids: [f1.id, f2.id, f3.id], embedding: [0.5, 0.5, 0] });
      await store.putTheme(theme);
      await index.rebuild(store);

      const consolidator = new MemoryConsolidator(store, index, { dedupThreshold: 0.9 });
      await consolidator.consolidate();

      const updated = await store.getTheme(theme.id);
      expect(updated).not.toBeNull();
      expect(updated!.fact_ids).toHaveLength(2);

      const remaining = await store.findFacts({ includeInvalidated: false });
      const survivingEmbeddings = remaining
        .filter((f) => updated!.fact_ids.includes(f.id) && f.embedding)
        .map((f) => f.embedding!);
      expect(survivingEmbeddings).toHaveLength(2);
      const expectedCentroid = survivingEmbeddings[0].map(
        (_, i) => survivingEmbeddings.reduce((sum, e) => sum + e[i], 0) / survivingEmbeddings.length,
      );
      expect(updated!.embedding).toEqual(expectedCentroid);
    });

    it('only updates themes affected by a pruned fact', async () => {
      const f1 = makeFact({ content: 'A', embedding: [1, 0, 0] });
      const f2 = makeFact({ content: 'A dup', embedding: [0.99, 0.1, 0] });
      const f3 = makeFact({ content: 'C', embedding: [0, 0, 1] });
      const f4 = makeFact({ content: 'D', embedding: [0, 1, 0] });
      await store.putFact(f1);
      await store.putFact(f2);
      await store.putFact(f3);
      await store.putFact(f4);

      const theme1 = makeTheme({ fact_ids: [f1.id, f2.id], label: 'Affected' });
      const theme2 = makeTheme({ fact_ids: [f3.id, f4.id], label: 'Unaffected' });
      await store.putTheme(theme1);
      await store.putTheme(theme2);
      await index.rebuild(store);

      const consolidator = new MemoryConsolidator(store, index, { dedupThreshold: 0.9 });
      const report = await consolidator.consolidate();

      expect(report.themesCleanedUp).toBe(1);
      const t2 = await store.getTheme(theme2.id);
      expect(t2!.fact_ids).toHaveLength(2);
    });

    it('cascades cleanup in hard-delete mode', async () => {
      const f1 = makeFact({ content: 'A', embedding: [1, 0, 0] });
      const f2 = makeFact({ content: 'A dup', embedding: [0.99, 0.1, 0] });
      await store.putFact(f1);
      await store.putFact(f2);

      const theme = makeTheme({ fact_ids: [f1.id, f2.id] });
      await store.putTheme(theme);
      await index.rebuild(store);

      const consolidator = new MemoryConsolidator(store, index, { dedupThreshold: 0.9, deleteMode: 'hard' });
      const report = await consolidator.consolidate();

      expect(report.factsDeduped).toBe(1);
      expect(report.themesCleanedUp).toBe(1);
      const all = await store.findFacts({ includeInvalidated: true });
      expect(all).toHaveLength(1);
    });

    it('cascades cleanup in soft-delete mode', async () => {
      const f1 = makeFact({ content: 'A', embedding: [1, 0, 0] });
      const f2 = makeFact({ content: 'A dup', embedding: [0.99, 0.1, 0] });
      await store.putFact(f1);
      await store.putFact(f2);

      const theme = makeTheme({ fact_ids: [f1.id, f2.id] });
      await store.putTheme(theme);
      await index.rebuild(store);

      const consolidator = new MemoryConsolidator(store, index, { dedupThreshold: 0.9, deleteMode: 'soft' });
      const report = await consolidator.consolidate();

      expect(report.factsDeduped).toBe(1);
      expect(report.themesCleanedUp).toBe(1);
      const invalidated = await store.findFacts({ includeInvalidated: true });
      expect(invalidated).toHaveLength(2);
      const active = await store.findFacts({ includeInvalidated: false });
      expect(active).toHaveLength(1);
    });

    it('makes no theme changes when no facts are pruned', async () => {
      const f1 = makeFact({ content: 'A', embedding: [1, 0, 0] });
      const f2 = makeFact({ content: 'B', embedding: [0, 1, 0] });
      await store.putFact(f1);
      await store.putFact(f2);

      const theme = makeTheme({ fact_ids: [f1.id, f2.id] });
      await store.putTheme(theme);
      await index.rebuild(store);

      const consolidator = new MemoryConsolidator(store, index);
      const report = await consolidator.consolidate();

      expect(report.themesCleanedUp).toBe(0);
      expect(report.themesRemoved).toBe(0);
      const t = await store.getTheme(theme.id);
      expect(t!.fact_ids).toHaveLength(2);
    });

    it('leaves stale fact references intact while dropping the deduped fact', async () => {
      const f1 = makeFact({ content: 'A', embedding: [1, 0, 0] });
      const f2 = makeFact({ content: 'A dup', embedding: [0.99, 0.1, 0] });
      const staleId = crypto.randomUUID();
      await store.putFact(f1);
      await store.putFact(f2);

      const theme = makeTheme({ fact_ids: [f1.id, f2.id, staleId] });
      await store.putTheme(theme);
      await index.rebuild(store);

      const consolidator = new MemoryConsolidator(store, index, { dedupThreshold: 0.9 });
      const report = await consolidator.consolidate();

      expect(report.factsDeduped).toBe(1);
      expect(report.themesCleanedUp).toBe(1);
      const t = await store.getTheme(theme.id);
      expect(t!.fact_ids).toHaveLength(2);
      expect(t!.fact_ids).toContain(staleId);
    });

    it('computes the centroid using only facts that have embeddings', async () => {
      const f1 = makeFact({ content: 'Has embedding', embedding: [1, 0, 0] });
      const f2 = makeFact({ content: 'No embedding' });
      const f3 = makeFact({ content: 'Dup of f1', embedding: [0.99, 0.1, 0] });
      await store.putFact(f1);
      await store.putFact(f2);
      await store.putFact(f3);

      const theme = makeTheme({ fact_ids: [f1.id, f2.id, f3.id] });
      await store.putTheme(theme);
      await index.rebuild(store);

      const consolidator = new MemoryConsolidator(store, index, { dedupThreshold: 0.9 });
      await consolidator.consolidate();

      const t = await store.getTheme(theme.id);
      expect(t).not.toBeNull();
      expect(t!.embedding).toBeDefined();
      expect(t!.embedding).toHaveLength(3);
    });

    it('sets the embedding to undefined when no remaining fact has an embedding', async () => {
      const f1 = makeFact({ content: 'Old no emb', valid_from: daysAgo(90), access_count: 0 });
      const f2 = makeFact({ content: 'No emb either' });
      const keeper = makeFact({ content: 'Fresh keeper', valid_from: daysAgo(1), access_count: 10 });
      await store.putFact(f1);
      await store.putFact(f2);
      await store.putFact(keeper);

      const theme = makeTheme({ fact_ids: [f1.id, f2.id], embedding: [1, 0, 0] });
      await store.putTheme(theme);

      const consolidator = new MemoryConsolidator(store, index, { maxFacts: 2, decayHalfLifeDays: 30 });
      const report = await consolidator.consolidate();

      expect(report.themesCleanedUp).toBe(1);
      const t = await store.getTheme(theme.id);
      expect(t).not.toBeNull();
      expect(t!.embedding).toBeUndefined();
    });

    it('cleans up every theme that references a deduped fact', async () => {
      const f1 = makeFact({ content: 'A', embedding: [1, 0, 0] });
      const f2 = makeFact({ content: 'A dup', embedding: [0.99, 0.1, 0] });
      const f3 = makeFact({ content: 'C', embedding: [0, 0, 1] });
      await store.putFact(f1);
      await store.putFact(f2);
      await store.putFact(f3);

      const theme1 = makeTheme({ fact_ids: [f1.id, f2.id, f3.id] });
      const theme2 = makeTheme({ fact_ids: [f2.id, f3.id] });
      await store.putTheme(theme1);
      await store.putTheme(theme2);
      await index.rebuild(store);

      const consolidator = new MemoryConsolidator(store, index, { dedupThreshold: 0.9 });
      const report = await consolidator.consolidate();

      expect(report.themesCleanedUp).toBeGreaterThanOrEqual(1);
    });

    it('reports themesRemoved for each fully-emptied theme and leaves survivors', async () => {
      const f1 = makeFact({ content: 'Old 1', valid_from: daysAgo(90), access_count: 0 });
      const f2 = makeFact({ content: 'Old 2', valid_from: daysAgo(80), access_count: 0 });
      const keeper = makeFact({ content: 'Fresh', valid_from: daysAgo(1), access_count: 10 });
      await store.putFact(f1);
      await store.putFact(f2);
      await store.putFact(keeper);

      const theme1 = makeTheme({ fact_ids: [f1.id] });
      const theme2 = makeTheme({ fact_ids: [f2.id] });
      const theme3 = makeTheme({ fact_ids: [keeper.id] });
      await store.putTheme(theme1);
      await store.putTheme(theme2);
      await store.putTheme(theme3);

      const consolidator = new MemoryConsolidator(store, index, { maxFacts: 1, decayHalfLifeDays: 30 });
      const report = await consolidator.consolidate();

      expect(report.themesRemoved).toBe(2);
      expect(report.themesCleanedUp).toBe(0);
      const t3 = await store.getTheme(theme3.id);
      expect(t3).not.toBeNull();
    });

    it('includes removed themes in totalReclaimed', async () => {
      const f1 = makeFact({ content: 'Old', valid_from: daysAgo(90), access_count: 0 });
      const keeper = makeFact({ content: 'Fresh', valid_from: daysAgo(1), access_count: 10 });
      await store.putFact(f1);
      await store.putFact(keeper);

      const theme = makeTheme({ fact_ids: [f1.id] });
      await store.putTheme(theme);

      const consolidator = new MemoryConsolidator(store, index, { maxFacts: 1, decayHalfLifeDays: 30 });
      const report = await consolidator.consolidate();

      expect(report.factsDecayed).toBe(1);
      expect(report.themesRemoved).toBe(1);
      expect(report.totalReclaimed).toBe(
        report.factsDeduped + report.factsDecayed + report.episodesPruned + report.themesRemoved,
      );
    });

    it('triggers cascade automatically during consolidate with maxFacts', async () => {
      const f1 = makeFact({ content: 'Old 1', valid_from: daysAgo(90), access_count: 0, embedding: [1, 0, 0] });
      const f2 = makeFact({ content: 'Fresh 1', valid_from: daysAgo(1), access_count: 5, embedding: [0, 1, 0] });
      await store.putFact(f1);
      await store.putFact(f2);

      const theme = makeTheme({ fact_ids: [f1.id, f2.id], embedding: [0.5, 0.5, 0] });
      await store.putTheme(theme);

      const consolidator = new MemoryConsolidator(store, index, { maxFacts: 1, decayHalfLifeDays: 30 });
      const report = await consolidator.consolidate();

      expect(report.factsDecayed).toBe(1);
      expect(report.themesCleanedUp).toBe(1);
      const t = await store.getTheme(theme.id);
      expect(t!.fact_ids).toHaveLength(1);
      expect(t!.fact_ids[0]).toBe(f2.id);
    });

    it('triggers cascade automatically during consolidate with dedup', async () => {
      const f1 = makeFact({ content: 'Fact X', embedding: [1, 0, 0] });
      const f2 = makeFact({ content: 'Fact X dup', embedding: [0.99, 0.1, 0] });
      const f3 = makeFact({ content: 'Unrelated', embedding: [0, 0, 1] });
      await store.putFact(f1);
      await store.putFact(f2);
      await store.putFact(f3);

      const theme = makeTheme({ fact_ids: [f1.id, f2.id, f3.id], embedding: [0.5, 0.5, 0] });
      await store.putTheme(theme);
      await index.rebuild(store);

      const consolidator = new MemoryConsolidator(store, index, { dedupThreshold: 0.9 });
      const report = await consolidator.consolidate();

      expect(report.factsDeduped).toBe(1);
      expect(report.themesCleanedUp).toBe(1);
      const t = await store.getTheme(theme.id);
      expect(t!.fact_ids).toHaveLength(2);
    });
  });
});
