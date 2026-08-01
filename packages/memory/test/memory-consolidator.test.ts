/**
 * Tests for MemoryConsolidator: dedup, decay, episode pruning, theme
 * cascade, mutation application, and the auto-consolidation entry points.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { InMemoryMemoryStore } from '../src/store/in-memory-store.js';
import { InMemoryMemoryIndex } from '../src/search/in-memory-index.js';
import { MemoryConsolidator } from '../src/consolidation/memory-consolidator.js';
import { makeFact, makeEpisode, makeTheme } from './helpers.js';

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

  describe('dedup', () => {
    it('deduplicates near-identical facts by embedding similarity', async () => {
      const f1 = makeFact({ content: 'Alice works at Acme', embedding: [1, 0, 0] });
      const f2 = makeFact({ content: 'Alice works at Acme Corp', embedding: [0.99, 0.1, 0] });
      await store.putFact(f1);
      await store.putFact(f2);
      await index.rebuild(store);

      const consolidator = new MemoryConsolidator(store, index, { dedupThreshold: 0.9 });
      const report = await consolidator.consolidate();

      expect(report.factsDeduped).toBe(1);
      const remaining = await store.findFacts({ includeInvalidated: false });
      expect(remaining).toHaveLength(1);
    });

    it('keeps the fact with more source episode IDs', async () => {
      const ep1 = crypto.randomUUID();
      const ep2 = crypto.randomUUID();
      const f1 = makeFact({ content: 'Fact A', embedding: [1, 0, 0], source_episode_ids: [ep1] });
      const f2 = makeFact({ content: 'Fact B', embedding: [1, 0, 0], source_episode_ids: [ep1, ep2] });
      await store.putFact(f1);
      await store.putFact(f2);
      await index.rebuild(store);

      const consolidator = new MemoryConsolidator(store, index, { dedupThreshold: 0.9 });
      await consolidator.consolidate();

      const remaining = await store.findFacts({ includeInvalidated: false });
      expect(remaining).toHaveLength(1);
      expect(remaining[0].id).toBe(f2.id);
    });

    it('keeps the newer fact when source episode counts are equal', async () => {
      const f1 = makeFact({ content: 'Fact old', embedding: [1, 0, 0], valid_from: daysAgo(10) });
      const f2 = makeFact({ content: 'Fact new', embedding: [1, 0, 0], valid_from: daysAgo(1) });
      await store.putFact(f1);
      await store.putFact(f2);
      await index.rebuild(store);

      const consolidator = new MemoryConsolidator(store, index, { dedupThreshold: 0.9 });
      await consolidator.consolidate();

      const remaining = await store.findFacts({ includeInvalidated: false });
      expect(remaining).toHaveLength(1);
      expect(remaining[0].id).toBe(f2.id);
    });

    it('keeps the highest-access fact and sums access counts when none are verified', async () => {
      const a = makeFact({ content: 'a', embedding: [1, 0, 0], access_count: 5 });
      const b = makeFact({ content: 'b', embedding: [1, 0, 0], access_count: 10 });
      const c = makeFact({ content: 'c', embedding: [1, 0, 0], access_count: 2 });
      await store.putFact(a);
      await store.putFact(b);
      await store.putFact(c);
      await index.rebuild(store);

      const consolidator = new MemoryConsolidator(store, index, { dedupThreshold: 0.9 });
      const report = await consolidator.consolidate();

      expect(report.factsDeduped).toBe(2);
      const remaining = await store.findFacts({ includeInvalidated: false });
      expect(remaining).toHaveLength(1);
      expect(remaining[0].id).toBe(b.id);
      expect(remaining[0].access_count).toBe(17);
    });

    it('keeps the verified fact over a newer candidate and merges its evidence', async () => {
      const ep1 = crypto.randomUUID();
      const ep2 = crypto.randomUUID();
      const verified = makeFact({
        content: 'Retry with backoff on 429',
        embedding: [1, 0, 0],
        valid_from: daysAgo(10),
        tags: ['verified', 'lesson'],
        access_count: 5,
        source_episode_ids: [ep1],
      });
      const candidate = makeFact({
        content: 'Retry with backoff on 429 errors',
        embedding: [1, 0, 0],
        valid_from: daysAgo(1),
        tags: ['candidate'],
        access_count: 1,
        source_episode_ids: [ep2],
      });
      await store.putFact(verified);
      await store.putFact(candidate);
      await index.rebuild(store);

      const consolidator = new MemoryConsolidator(store, index, { dedupThreshold: 0.9 });
      await consolidator.consolidate();

      const remaining = await store.findFacts({ includeInvalidated: false });
      expect(remaining).toHaveLength(1);
      expect(remaining[0].id).toBe(verified.id);
      expect(remaining[0].tags).toContain('verified');
      expect(remaining[0].tags).not.toContain('candidate');
      expect(remaining[0].access_count).toBe(6);
      expect(new Set(remaining[0].source_episode_ids)).toEqual(new Set([ep1, ep2]));
    });

    it('keeps the verified fact when the unverified duplicate is encountered first', async () => {
      const candidate = makeFact({ content: 'dup a', embedding: [1, 0, 0], tags: ['candidate'] });
      const verified = makeFact({ content: 'dup b', embedding: [1, 0, 0], tags: ['verified'] });
      await store.putFact(candidate);
      await store.putFact(verified);
      await index.rebuild(store);

      const consolidator = new MemoryConsolidator(store, index, { dedupThreshold: 0.9 });
      await consolidator.consolidate();

      const remaining = await store.findFacts({ includeInvalidated: false });
      expect(remaining).toHaveLength(1);
      expect(remaining[0].id).toBe(verified.id);
    });

    it('unions loser entity_ids into the survivor', async () => {
      const entA = crypto.randomUUID();
      const entB = crypto.randomUUID();
      const keeper = makeFact({
        content: 'Alice leads the Widget project',
        embedding: [1, 0, 0],
        valid_from: daysAgo(1),
        source_episode_ids: [crypto.randomUUID()],
        entity_ids: [entA],
      });
      const loser = makeFact({
        content: 'Alice leads the Widget project team',
        embedding: [1, 0, 0],
        valid_from: daysAgo(2),
        source_episode_ids: [],
        entity_ids: [entB],
      });
      await store.putFact(keeper);
      await store.putFact(loser);
      await index.rebuild(store);

      const consolidator = new MemoryConsolidator(store, index, { dedupThreshold: 0.9 });
      await consolidator.consolidate();

      const remaining = await store.findFacts({ includeInvalidated: false });
      expect(remaining).toHaveLength(1);
      expect(new Set(remaining[0].entity_ids)).toEqual(new Set([entA, entB]));
    });

    it('excludes quarantined facts from dedup', async () => {
      const good = makeFact({ content: 'Alice works at Acme', embedding: [1, 0, 0], tags: ['lesson'] });
      const poisoned = makeFact({ content: 'Alice works at Acme Corp', embedding: [0.99, 0.1, 0], tags: ['quarantined'] });
      await store.putFact(good);
      await store.putFact(poisoned);
      await index.rebuild(store);

      const consolidator = new MemoryConsolidator(store, index, { dedupThreshold: 0.9 });
      const report = await consolidator.consolidate();

      expect(report.factsDeduped).toBe(0);
      const good2 = await store.getFact(good.id);
      expect(good2?.invalidated_by).toBeUndefined();
    });

    it('sets invalidated_by on the loser in soft-delete mode', async () => {
      const f1 = makeFact({ content: 'A', embedding: [1, 0, 0], valid_from: daysAgo(1) });
      const f2 = makeFact({ content: 'B', embedding: [1, 0, 0], valid_from: daysAgo(5) });
      await store.putFact(f1);
      await store.putFact(f2);
      await index.rebuild(store);

      const consolidator = new MemoryConsolidator(store, index, { dedupThreshold: 0.9, deleteMode: 'soft' });
      await consolidator.consolidate();

      const all = await store.findFacts({ includeInvalidated: true });
      const invalidated = all.filter((f) => f.invalidated_by);
      expect(invalidated).toHaveLength(1);
      expect(invalidated[0].invalidated_by).toBe(f1.id);
    });

    it('removes the loser from the store in hard-delete mode', async () => {
      const f1 = makeFact({ content: 'A', embedding: [1, 0, 0] });
      const f2 = makeFact({ content: 'B', embedding: [1, 0, 0] });
      await store.putFact(f1);
      await store.putFact(f2);
      await index.rebuild(store);

      const consolidator = new MemoryConsolidator(store, index, { dedupThreshold: 0.9, deleteMode: 'hard' });
      await consolidator.consolidate();

      const all = await store.findFacts({ includeInvalidated: true });
      expect(all).toHaveLength(1);
    });

    it('skips already-invalidated facts', async () => {
      const f1 = makeFact({ content: 'A', embedding: [1, 0, 0], invalidated_by: 'some-reason' });
      const f2 = makeFact({ content: 'B', embedding: [1, 0, 0] });
      await store.putFact(f1);
      await store.putFact(f2);
      await index.rebuild(store);

      const consolidator = new MemoryConsolidator(store, index, { dedupThreshold: 0.9 });
      const report = await consolidator.consolidate();

      expect(report.factsDeduped).toBe(0);
    });

    it('merges near-duplicates whose tags field is undefined', async () => {
      const f1 = makeFact({ content: 'A', embedding: [1, 0, 0], tags: undefined, valid_from: daysAgo(1) });
      const f2 = makeFact({ content: 'B', embedding: [1, 0, 0], tags: undefined, valid_from: daysAgo(2) });
      await store.putFact(f1);
      await store.putFact(f2);
      await index.rebuild(store);

      const consolidator = new MemoryConsolidator(store, index, { dedupThreshold: 0.9 });
      const report = await consolidator.consolidate();

      expect(report.factsDeduped).toBe(1);
      const remaining = await store.findFacts({ includeInvalidated: false });
      expect(remaining).toHaveLength(1);
      expect(remaining[0].id).toBe(f1.id);
    });

    it('handles facts without embeddings gracefully', async () => {
      const f1 = makeFact({ content: 'No embedding 1' });
      const f2 = makeFact({ content: 'No embedding 2' });
      await store.putFact(f1);
      await store.putFact(f2);
      await index.rebuild(store);

      const consolidator = new MemoryConsolidator(store, index, { dedupThreshold: 0.9 });
      const report = await consolidator.consolidate();

      expect(report.factsDeduped).toBe(0);
      const remaining = await store.findFacts();
      expect(remaining).toHaveLength(2);
    });

    it('does not dedup when only one fact exists', async () => {
      const f = makeFact({ content: 'Solo', embedding: [1, 0, 0] });
      await store.putFact(f);
      await index.rebuild(store);

      const consolidator = new MemoryConsolidator(store, index, { dedupThreshold: 0.9 });
      const report = await consolidator.consolidate();

      expect(report.factsDeduped).toBe(0);
      const remaining = await store.findFacts();
      expect(remaining).toHaveLength(1);
    });

    it('is idempotent — a second run produces zero changes', async () => {
      const f1 = makeFact({ content: 'A', embedding: [1, 0, 0] });
      const f2 = makeFact({ content: 'B', embedding: [1, 0, 0] });
      await store.putFact(f1);
      await store.putFact(f2);
      await index.rebuild(store);

      const consolidator = new MemoryConsolidator(store, index, { dedupThreshold: 0.9 });
      const report1 = await consolidator.consolidate();
      expect(report1.factsDeduped).toBe(1);

      await index.rebuild(store);
      const report2 = await consolidator.consolidate();
      expect(report2.factsDeduped).toBe(0);
      expect(report2.totalReclaimed).toBe(0);
    });
  });

  describe('decay', () => {
    it('prunes old facts with no access when under maxFacts budget', async () => {
      const oldFact = makeFact({ content: 'Old fact', valid_from: daysAgo(60), access_count: 0 });
      const newFact = makeFact({ content: 'New fact', valid_from: daysAgo(1), access_count: 0 });
      await store.putFact(oldFact);
      await store.putFact(newFact);

      const consolidator = new MemoryConsolidator(store, index, { maxFacts: 1, decayHalfLifeDays: 30 });
      const report = await consolidator.consolidate();

      expect(report.factsDecayed).toBe(1);
      const remaining = await store.findFacts({ includeInvalidated: false });
      expect(remaining).toHaveLength(1);
      expect(remaining[0].id).toBe(newFact.id);
    });

    it('ages from last access, not creation, so a recently-used old fact outlives an untouched newer one', async () => {
      const oldButUsed = makeFact({
        content: 'Old, retrieved yesterday',
        valid_from: daysAgo(60),
        last_accessed_at: daysAgo(1),
        access_count: 1,
      });
      const newerUntouched = makeFact({ content: 'Newer, never retrieved', valid_from: daysAgo(30) });
      await store.putFact(oldButUsed);
      await store.putFact(newerUntouched);

      const consolidator = new MemoryConsolidator(store, index, { maxFacts: 1, decayHalfLifeDays: 30 });
      const report = await consolidator.consolidate();

      expect(report.factsDecayed).toBe(1);
      const remaining = await store.findFacts({ includeInvalidated: false });
      expect(remaining[0].id).toBe(oldButUsed.id);
    });

    it('treats a schema-default access_count of 0 as baseline, not a zeroed score', async () => {
      const oldUndefined = makeFact({ content: 'Old, count undefined', valid_from: daysAgo(60) });
      const newZero = makeFact({ content: 'New, count 0', valid_from: daysAgo(1), access_count: 0 });
      await store.putFact(oldUndefined);
      await store.putFact(newZero);

      const consolidator = new MemoryConsolidator(store, index, { maxFacts: 1, decayHalfLifeDays: 30 });
      const report = await consolidator.consolidate();

      expect(report.factsDecayed).toBe(1);
      const remaining = await store.findFacts({ includeInvalidated: false });
      expect(remaining[0].id).toBe(newZero.id);
    });

    it('keeps recent facts even with no access count', async () => {
      const f1 = makeFact({ content: 'Recent', valid_from: daysAgo(1), access_count: 0 });
      const f2 = makeFact({ content: 'Also recent', valid_from: daysAgo(2), access_count: 0 });
      await store.putFact(f1);
      await store.putFact(f2);

      const consolidator = new MemoryConsolidator(store, index, { maxFacts: 2, decayHalfLifeDays: 30 });
      const report = await consolidator.consolidate();

      expect(report.factsDecayed).toBe(0);
    });

    it('keeps frequently accessed old facts over rarely accessed new ones', async () => {
      const oldPopular = makeFact({ content: 'Old popular', valid_from: daysAgo(60), access_count: 100 });
      const newUnpopular = makeFact({ content: 'New unpopular', valid_from: daysAgo(1), access_count: 0 });
      await store.putFact(oldPopular);
      await store.putFact(newUnpopular);

      const consolidator = new MemoryConsolidator(store, index, { maxFacts: 1, decayHalfLifeDays: 30 });
      const report = await consolidator.consolidate();

      expect(report.factsDecayed).toBe(1);
      const remaining = await store.findFacts({ includeInvalidated: false });
      expect(remaining).toHaveLength(1);
      expect(remaining[0].id).toBe(oldPopular.id);
    });

    it('prunes lowest-scoring facts first to meet the maxFacts budget', async () => {
      const facts = [
        makeFact({ content: 'A', valid_from: daysAgo(90), access_count: 0 }),
        makeFact({ content: 'B', valid_from: daysAgo(30), access_count: 0 }),
        makeFact({ content: 'C', valid_from: daysAgo(1), access_count: 0 }),
      ];
      for (const f of facts) await store.putFact(f);

      const consolidator = new MemoryConsolidator(store, index, { maxFacts: 1 });
      const report = await consolidator.consolidate();

      expect(report.factsDecayed).toBe(2);
      const remaining = await store.findFacts({ includeInvalidated: false });
      expect(remaining).toHaveLength(1);
      expect(remaining[0].id).toBe(facts[2].id);
    });

    it('does not prune facts when maxFacts is not set', async () => {
      for (let i = 0; i < 5; i++) {
        await store.putFact(makeFact({ valid_from: daysAgo(100) }));
      }

      const consolidator = new MemoryConsolidator(store, index);
      const report = await consolidator.consolidate();

      expect(report.factsDecayed).toBe(0);
      const remaining = await store.findFacts();
      expect(remaining).toHaveLength(5);
    });

    it('uses the configured half-life for decay scoring', async () => {
      const oldFact = makeFact({ content: 'Old', valid_from: daysAgo(20), access_count: 1 });
      const newFact = makeFact({ content: 'New', valid_from: daysAgo(1), access_count: 1 });
      await store.putFact(oldFact);
      await store.putFact(newFact);

      const consolidator = new MemoryConsolidator(store, index, { maxFacts: 1, decayHalfLifeDays: 10 });
      const report = await consolidator.consolidate();

      expect(report.factsDecayed).toBe(1);
      const remaining = await store.findFacts({ includeInvalidated: false });
      expect(remaining).toHaveLength(1);
      expect(remaining[0].id).toBe(newFact.id);
    });

    it('hard-deletes decayed facts in hard-delete mode', async () => {
      const oldFact = makeFact({ content: 'old', valid_from: daysAgo(90), access_count: 0 });
      const newFact = makeFact({ content: 'fresh', valid_from: daysAgo(1), access_count: 0 });
      await store.putFact(oldFact);
      await store.putFact(newFact);

      const consolidator = new MemoryConsolidator(store, index, { maxFacts: 1, deleteMode: 'hard' });
      const report = await consolidator.consolidate();

      expect(report.factsDecayed).toBe(1);
      const all = await store.findFacts({ includeInvalidated: true });
      expect(all).toHaveLength(1);
      expect(all[0].id).toBe(newFact.id);
    });

    it('pages through facts in batches when loading for dedup and decay', async () => {
      for (let i = 0; i < 5; i++) {
        await store.putFact(makeFact({ content: `f${i}`, valid_from: daysAgo(i), access_count: 1 }));
      }

      const consolidator = new MemoryConsolidator(store, index, { maxFacts: 3, batchSize: 2 });
      const report = await consolidator.consolidate();

      expect(report.factsDecayed).toBe(2);
      const remaining = await store.findFacts({ includeInvalidated: false });
      expect(remaining).toHaveLength(3);
    });
  });

  describe('episode pruning', () => {
    it('prunes the oldest episodes when exceeding maxEpisodes', async () => {
      const episodes = [
        makeEpisode({ topic: 'oldest', started_at: daysAgo(30) }),
        makeEpisode({ topic: 'middle', started_at: daysAgo(15) }),
        makeEpisode({ topic: 'newest', started_at: daysAgo(1) }),
      ];
      for (const e of episodes) await store.putEpisode(e);

      const consolidator = new MemoryConsolidator(store, index, { maxEpisodes: 1 });
      const report = await consolidator.consolidate();

      expect(report.episodesPruned).toBe(2);
      const remaining = await store.listEpisodes();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].id).toBe(episodes[2].id);
    });

    it('pages through the whole store so episodes beyond the first batch are prunable', async () => {
      const episodes = [1, 2, 3, 4, 5].map((d) =>
        makeEpisode({ topic: `ep-${d}`, started_at: daysAgo(d), ended_at: daysAgo(d) }),
      );
      for (const ep of episodes) await store.putEpisode(ep);

      const consolidator = new MemoryConsolidator(store, index, { maxEpisodes: 3, batchSize: 2 });
      const report = await consolidator.consolidate();

      expect(report.episodesPruned).toBe(2);
      const remaining = await store.listEpisodes({ limit: 100 });
      const topics = remaining.map((e) => e.topic).sort();
      expect(topics).toEqual(['ep-1', 'ep-2', 'ep-3']);
    });

    it('does not prune episodes when maxEpisodes is not set', async () => {
      for (let i = 0; i < 5; i++) {
        await store.putEpisode(makeEpisode());
      }

      const consolidator = new MemoryConsolidator(store, index);
      const report = await consolidator.consolidate();

      expect(report.episodesPruned).toBe(0);
    });

    it('does not prune episodes when the count is within maxEpisodes', async () => {
      await store.putEpisode(makeEpisode());
      await store.putEpisode(makeEpisode());

      const consolidator = new MemoryConsolidator(store, index, { maxEpisodes: 5 });
      const report = await consolidator.consolidate();

      expect(report.episodesPruned).toBe(0);
    });
  });

  describe('theme centroid', () => {
    it('recomputes a finite centroid when embeddings have mixed dimensions', async () => {
      const f1 = makeFact({ content: 'Fact A', embedding: [1, 0, 0], valid_from: daysAgo(1) });
      const f2 = makeFact({ content: 'Fact B', embedding: [0, 1, 0], valid_from: daysAgo(1) });
      const f3 = makeFact({ content: 'Fact C', embedding: [0.5, 0.5], valid_from: daysAgo(1) });
      await store.putFact(f1);
      await store.putFact(f2);
      await store.putFact(f3);

      const theme = makeTheme({
        label: 'Test theme',
        fact_ids: [f1.id, f2.id, f3.id],
        embedding: [0.5, 0.5, 0],
      });
      await store.putTheme(theme);
      await index.rebuild(store);

      const consolidator = new MemoryConsolidator(store, index, {
        dedupThreshold: 0.9,
        maxFacts: 2,
        decayHalfLifeDays: 1,
      });
      await consolidator.consolidate();

      const themes = await store.listThemes();
      for (const t of themes) {
        for (const v of t.embedding ?? []) {
          expect(Number.isFinite(v)).toBe(true);
        }
      }
    });
  });

  describe('mutation conflicts', () => {
    async function seedKeeperAlsoDecayed(
      consolidatorOptions: ConstructorParameters<typeof MemoryConsolidator>[2],
    ): Promise<{ keeper: ReturnType<typeof makeFact>; loser: ReturnType<typeof makeFact>; fresh: ReturnType<typeof makeFact> }> {
      const ep1 = crypto.randomUUID();
      const ep2 = crypto.randomUUID();
      const keeper = makeFact({
        content: 'dup keeper',
        embedding: [1, 0, 0],
        valid_from: daysAgo(90),
        access_count: 0,
        source_episode_ids: [ep1, ep2],
      });
      const loser = makeFact({
        content: 'dup loser',
        embedding: [1, 0, 0],
        valid_from: daysAgo(1),
        access_count: 0,
        source_episode_ids: [ep1],
      });
      const fresh = makeFact({ content: 'fresh', valid_from: daysAgo(1), access_count: 100 });
      await store.putFact(keeper);
      await store.putFact(loser);
      await store.putFact(fresh);
      await index.rebuild(store);

      const consolidator = new MemoryConsolidator(store, index, consolidatorOptions);
      await consolidator.consolidate();

      return { keeper, loser, fresh };
    }

    it('skips a fact that is both a dedup keeper and a decay hard-delete, warning via the logger', async () => {
      const warnings: string[] = [];
      const logger = { warn: (m: string) => warnings.push(m) };

      const { keeper, loser, fresh } = await seedKeeperAlsoDecayed({
        dedupThreshold: 0.9,
        maxFacts: 1,
        deleteMode: 'hard',
        logger,
      });

      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(keeper.id);
      const all = await store.findFacts({ includeInvalidated: true });
      expect(all.map((f) => f.id).sort()).toEqual([keeper.id, fresh.id].sort());
      expect(all.map((f) => f.id)).not.toContain(loser.id);
    });

    it('warns via console.warn when no logger is provided for conflicting mutations', async () => {
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const { keeper } = await seedKeeperAlsoDecayed({
        dedupThreshold: 0.9,
        maxFacts: 1,
        deleteMode: 'hard',
      });

      expect(spy).toHaveBeenCalledOnce();
      expect(spy.mock.calls[0][0]).toContain(keeper.id);

      spy.mockRestore();
    });
  });

  describe('report', () => {
    it('returns an all-zero report for an empty store', async () => {
      const consolidator = new MemoryConsolidator(store, index);
      const report = await consolidator.consolidate();

      expect(report).toEqual({
        factsDeduped: 0,
        factsDecayed: 0,
        episodesPruned: 0,
        themesCleanedUp: 0,
        themesRemoved: 0,
        totalReclaimed: 0,
      });
    });

    it('sums totalReclaimed across dedup, decay, and episode pruning', async () => {
      const f1 = makeFact({ content: 'dup1', embedding: [1, 0, 0], valid_from: daysAgo(1) });
      const f2 = makeFact({ content: 'dup2', embedding: [1, 0, 0], valid_from: daysAgo(2) });
      const f3 = makeFact({ content: 'extra1', valid_from: daysAgo(90) });
      const f4 = makeFact({ content: 'extra2', valid_from: daysAgo(80) });
      const f5 = makeFact({ content: 'keeper', valid_from: daysAgo(1) });
      for (const f of [f1, f2, f3, f4, f5]) await store.putFact(f);
      await index.rebuild(store);

      const e1 = makeEpisode({ started_at: daysAgo(30) });
      const e2 = makeEpisode({ started_at: daysAgo(1) });
      await store.putEpisode(e1);
      await store.putEpisode(e2);

      const consolidator = new MemoryConsolidator(store, index, {
        dedupThreshold: 0.9,
        maxFacts: 2,
        maxEpisodes: 1,
      });
      const report = await consolidator.consolidate();

      expect(report.totalReclaimed).toBe(
        report.factsDeduped + report.factsDecayed + report.episodesPruned,
      );
    });

    it('runs dedup, decay, and episode pruning in a single consolidate call', async () => {
      const dup1 = makeFact({ content: 'dup', embedding: [1, 0, 0], valid_from: daysAgo(1) });
      const dup2 = makeFact({ content: 'dup', embedding: [1, 0, 0], valid_from: daysAgo(2) });
      const old = makeFact({ content: 'old', valid_from: daysAgo(90), access_count: 0 });
      const recent = makeFact({ content: 'recent', valid_from: daysAgo(1) });
      for (const f of [dup1, dup2, old, recent]) await store.putFact(f);
      await index.rebuild(store);

      const ep1 = makeEpisode({ started_at: daysAgo(30) });
      const ep2 = makeEpisode({ started_at: daysAgo(1) });
      await store.putEpisode(ep1);
      await store.putEpisode(ep2);

      const consolidator = new MemoryConsolidator(store, index, {
        dedupThreshold: 0.9,
        maxFacts: 2,
        maxEpisodes: 1,
      });
      const report = await consolidator.consolidate();

      expect(report.factsDeduped).toBeGreaterThanOrEqual(1);
      expect(report.episodesPruned).toBe(1);
      expect(report.totalReclaimed).toBeGreaterThanOrEqual(2);
    });
  });

  describe('debug mode and mutation logging', () => {
    it('populates mutationLog when debug mode is on', async () => {
      const f1 = makeFact({ content: 'A', embedding: [1, 0, 0] });
      const f2 = makeFact({ content: 'B', embedding: [1, 0, 0], valid_from: daysAgo(5) });
      await store.putFact(f1);
      await store.putFact(f2);
      await index.rebuild(store);

      const consolidator = new MemoryConsolidator(store, index, { dedupThreshold: 0.9, debug: true });
      const report = await consolidator.consolidate();

      expect(report.mutationLog).toBeDefined();
      expect(report.mutationLog!.length).toBeGreaterThan(0);
      for (const entry of report.mutationLog!) {
        expect(entry.type).toBeDefined();
        expect(entry.id).toBeDefined();
      }
    });

    it('omits mutationLog when debug mode is off', async () => {
      const f1 = makeFact({ content: 'A', embedding: [1, 0, 0] });
      const f2 = makeFact({ content: 'B', embedding: [1, 0, 0], valid_from: daysAgo(5) });
      await store.putFact(f1);
      await store.putFact(f2);
      await index.rebuild(store);

      const consolidator = new MemoryConsolidator(store, index, { dedupThreshold: 0.9 });
      const report = await consolidator.consolidate();

      expect(report.mutationLog).toBeUndefined();
    });

    it('applies non-conflicting mutations normally with debug on', async () => {
      const oldFact = makeFact({ content: 'Old fact', valid_from: daysAgo(60), access_count: 0 });
      const newFact = makeFact({ content: 'New fact', valid_from: daysAgo(1), access_count: 0 });
      await store.putFact(oldFact);
      await store.putFact(newFact);

      const consolidator = new MemoryConsolidator(store, index, {
        maxFacts: 1,
        decayHalfLifeDays: 30,
        debug: true,
      });
      const report = await consolidator.consolidate();

      expect(report.factsDecayed).toBe(1);
      expect(report.mutationLog).toBeDefined();
      expect(report.mutationLog!.length).toBeGreaterThan(0);
      const remaining = await store.findFacts({ includeInvalidated: false });
      expect(remaining).toHaveLength(1);
      expect(remaining[0].id).toBe(newFact.id);
    });
  });

  describe('shouldConsolidate', () => {
    it('returns true when facts exceed the threshold', async () => {
      for (let i = 0; i < 5; i++) {
        await store.putFact(makeFact({ content: `Fact ${i}` }));
      }
      expect(await MemoryConsolidator.shouldConsolidate(store, { maxFacts: 3 })).toBe(true);
    });

    it('returns false when facts are under the threshold', async () => {
      for (let i = 0; i < 2; i++) {
        await store.putFact(makeFact({ content: `Fact ${i}` }));
      }
      expect(await MemoryConsolidator.shouldConsolidate(store, { maxFacts: 5 })).toBe(false);
    });

    it('returns true when episodes exceed the threshold', async () => {
      for (let i = 0; i < 5; i++) {
        await store.putEpisode(makeEpisode({ topic: `Episode ${i}` }));
      }
      expect(await MemoryConsolidator.shouldConsolidate(store, { maxEpisodes: 3 })).toBe(true);
    });

    it('returns false when episodes are under the threshold', async () => {
      await store.putEpisode(makeEpisode());
      expect(await MemoryConsolidator.shouldConsolidate(store, { maxEpisodes: 5 })).toBe(false);
    });

    it('returns false when no thresholds are set', async () => {
      for (let i = 0; i < 100; i++) {
        await store.putFact(makeFact({ content: `Fact ${i}` }));
      }
      expect(await MemoryConsolidator.shouldConsolidate(store, {})).toBe(false);
    });
  });

  describe('autoConsolidate', () => {
    it('returns null when consolidation is not needed', async () => {
      await store.putFact(makeFact({ content: 'Single fact' }));

      const consolidator = new MemoryConsolidator(store, index, { maxFacts: 1 });
      const result = await consolidator.autoConsolidate({ maxFacts: 10 });

      expect(result).toBeNull();
    });

    it('returns a report when consolidation is needed', async () => {
      for (let i = 0; i < 5; i++) {
        await store.putFact(makeFact({ content: `Fact ${i}`, valid_from: daysAgo(i * 10), access_count: 1 }));
      }

      const consolidator = new MemoryConsolidator(store, index, { maxFacts: 2 });
      const result = await consolidator.autoConsolidate({ maxFacts: 3 });

      expect(result).not.toBeNull();
      expect(result!.totalReclaimed).toBeGreaterThan(0);
    });
  });
});
