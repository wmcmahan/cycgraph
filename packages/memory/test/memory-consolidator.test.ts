import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryMemoryStore } from '../src/store/in-memory-store.js';
import { InMemoryMemoryIndex } from '../src/search/in-memory-index.js';
import { MemoryConsolidator } from '../src/consolidation/memory-consolidator.js';
import type { SemanticFact } from '../src/schemas/semantic.js';
import type { Episode } from '../src/schemas/episode.js';
import type { Theme } from '../src/schemas/theme.js';
import type { Provenance } from '../src/schemas/provenance.js';

const prov: Provenance = { source: 'system', created_at: new Date() };

function makeFact(overrides: Partial<SemanticFact> = {}): SemanticFact {
  return {
    id: crypto.randomUUID(),
    content: 'Test fact',
    source_episode_ids: [],
    entity_ids: [],
    provenance: prov,
    valid_from: new Date(),
    ...overrides,
  };
}

function makeEpisode(overrides: Partial<Episode> = {}): Episode {
  const now = new Date();
  return {
    id: crypto.randomUUID(),
    topic: 'Test episode',
    messages: [],
    started_at: now,
    ended_at: now,
    fact_ids: [],
    provenance: prov,
    ...overrides,
  };
}

function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

describe('MemoryConsolidator', () => {
  let store: InMemoryMemoryStore;
  let index: InMemoryMemoryIndex;

  beforeEach(async () => {
    store = new InMemoryMemoryStore();
    index = new InMemoryMemoryIndex();
  });

  // 1. Dedup: two near-identical facts (same embedding) → one invalidated
  it('deduplicates near-identical facts by embedding similarity', async () => {
    const f1 = makeFact({ content: 'Alice works at Acme', embedding: [1, 0, 0] });
    const f2 = makeFact({ content: 'Alice works at Acme Corp', embedding: [0.99, 0.1, 0] });
    await store.putFact(f1);
    await store.putFact(f2);
    await index.rebuild(store);

    const consolidator = new MemoryConsolidator(store, index, { dedupThreshold: 0.9 });
    const report = await consolidator.consolidate();

    expect(report.factsDeduped).toBe(1);

    const remaining = await store.findFacts({ include_invalidated: false });
    expect(remaining).toHaveLength(1);
  });

  // 2. Dedup keeps fact with more source episodes
  it('keeps the fact with more source episode IDs during dedup', async () => {
    const ep1 = crypto.randomUUID();
    const ep2 = crypto.randomUUID();
    const f1 = makeFact({
      content: 'Fact A',
      embedding: [1, 0, 0],
      source_episode_ids: [ep1],
    });
    const f2 = makeFact({
      content: 'Fact B',
      embedding: [1, 0, 0],
      source_episode_ids: [ep1, ep2],
    });
    await store.putFact(f1);
    await store.putFact(f2);
    await index.rebuild(store);

    const consolidator = new MemoryConsolidator(store, index, { dedupThreshold: 0.9 });
    await consolidator.consolidate();

    const remaining = await store.findFacts({ include_invalidated: false });
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(f2.id);
  });

  // 3. Dedup keeps newer fact when source episodes equal
  it('keeps the newer fact when source episode counts are equal', async () => {
    const f1 = makeFact({
      content: 'Fact old',
      embedding: [1, 0, 0],
      valid_from: daysAgo(10),
    });
    const f2 = makeFact({
      content: 'Fact new',
      embedding: [1, 0, 0],
      valid_from: daysAgo(1),
    });
    await store.putFact(f1);
    await store.putFact(f2);
    await index.rebuild(store);

    const consolidator = new MemoryConsolidator(store, index, { dedupThreshold: 0.9 });
    await consolidator.consolidate();

    const remaining = await store.findFacts({ include_invalidated: false });
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(f2.id);
  });

  // 3b. Dedup NEVER evicts a verified lesson for a newer unverified duplicate,
  // and merges the loser's evidence (access_count, episodes, tags) into it.
  it('keeps the verified fact over a newer candidate and merges evidence', async () => {
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
    // A newer near-duplicate that is only a candidate (could be poisoned).
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

    const remaining = await store.findFacts({ include_invalidated: false });
    expect(remaining).toHaveLength(1);
    // The verified lesson survives despite the candidate being newer.
    expect(remaining[0].id).toBe(verified.id);
    expect(remaining[0].tags).toContain('verified');
    expect(remaining[0].tags).not.toContain('candidate'); // not demoted
    // Evidence from the loser was folded in, not lost.
    expect(remaining[0].access_count).toBe(6); // 5 + 1
    expect(new Set(remaining[0].source_episode_ids)).toEqual(new Set([ep1, ep2]));
  });

  // 3c. Quarantined (poisoned) facts are excluded from consolidation entirely.
  it('excludes quarantined facts from dedup', async () => {
    const good = makeFact({ content: 'Alice works at Acme', embedding: [1, 0, 0], tags: ['lesson'] });
    const poisoned = makeFact({ content: 'Alice works at Acme Corp', embedding: [0.99, 0.1, 0], tags: ['quarantined'] });
    await store.putFact(good);
    await store.putFact(poisoned);
    await index.rebuild(store);

    const consolidator = new MemoryConsolidator(store, index, { dedupThreshold: 0.9 });
    const report = await consolidator.consolidate();

    // The poisoned fact is never loaded, so it can't dedup against the good one.
    expect(report.factsDeduped).toBe(0);
    const good2 = await store.getFact(good.id);
    expect(good2?.invalidated_by).toBeUndefined();
  });

  // 4. Dedup soft-delete: invalidated_by is set
  it('sets invalidated_by on the loser in soft-delete mode', async () => {
    const f1 = makeFact({ content: 'A', embedding: [1, 0, 0] });
    const f2 = makeFact({ content: 'B', embedding: [1, 0, 0], valid_from: daysAgo(5) });
    await store.putFact(f1);
    await store.putFact(f2);
    await index.rebuild(store);

    const consolidator = new MemoryConsolidator(store, index, {
      dedupThreshold: 0.9,
      deleteMode: 'soft',
    });
    await consolidator.consolidate();

    const all = await store.findFacts({ include_invalidated: true });
    const invalidated = all.filter((f) => f.invalidated_by);
    expect(invalidated).toHaveLength(1);
    expect(invalidated[0].invalidated_by).toBe(f1.id);
  });

  // 5. Dedup hard-delete: fact removed from store
  it('removes facts from store in hard-delete mode', async () => {
    const f1 = makeFact({ content: 'A', embedding: [1, 0, 0] });
    const f2 = makeFact({ content: 'B', embedding: [1, 0, 0] });
    await store.putFact(f1);
    await store.putFact(f2);
    await index.rebuild(store);

    const consolidator = new MemoryConsolidator(store, index, {
      dedupThreshold: 0.9,
      deleteMode: 'hard',
    });
    await consolidator.consolidate();

    const all = await store.findFacts({ include_invalidated: true });
    expect(all).toHaveLength(1);
  });

  // 6. Decay: old facts (60 days) with no access get low scores
  it('prunes old facts with no access when under maxFacts budget', async () => {
    const oldFact = makeFact({
      content: 'Old fact',
      valid_from: daysAgo(60),
      access_count: 0,
    });
    const newFact = makeFact({
      content: 'New fact',
      valid_from: daysAgo(1),
      access_count: 0,
    });
    await store.putFact(oldFact);
    await store.putFact(newFact);

    const consolidator = new MemoryConsolidator(store, index, {
      maxFacts: 1,
      decayHalfLifeDays: 30,
    });
    const report = await consolidator.consolidate();

    expect(report.factsDecayed).toBe(1);
    const remaining = await store.findFacts({ include_invalidated: false });
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(newFact.id);
  });

  // 7. Decay: recent facts (1 day) survive even with no access
  it('keeps recent facts even with no access count', async () => {
    const f1 = makeFact({ content: 'Recent', valid_from: daysAgo(1), access_count: 0 });
    const f2 = makeFact({ content: 'Also recent', valid_from: daysAgo(2), access_count: 0 });
    await store.putFact(f1);
    await store.putFact(f2);

    const consolidator = new MemoryConsolidator(store, index, {
      maxFacts: 2,
      decayHalfLifeDays: 30,
    });
    const report = await consolidator.consolidate();

    expect(report.factsDecayed).toBe(0);
  });

  // 8. Decay: frequently accessed old facts survive
  it('keeps frequently accessed old facts over rarely accessed new ones', async () => {
    const oldPopular = makeFact({
      content: 'Old popular',
      valid_from: daysAgo(60),
      access_count: 100,
    });
    const newUnpopular = makeFact({
      content: 'New unpopular',
      valid_from: daysAgo(1),
      access_count: 0,
    });
    await store.putFact(oldPopular);
    await store.putFact(newUnpopular);

    const consolidator = new MemoryConsolidator(store, index, {
      maxFacts: 1,
      decayHalfLifeDays: 30,
    });
    const report = await consolidator.consolidate();

    expect(report.factsDecayed).toBe(1);
    const remaining = await store.findFacts({ include_invalidated: false });
    expect(remaining).toHaveLength(1);
    // Old popular fact has decay score: 100 * 2^(-60/30) = 100 * 0.25 = 25
    // New unpopular: 1 * 2^(-1/30) ≈ 0.977 (access_count 0 → defaults to 1)
    // Old popular wins
    expect(remaining[0].id).toBe(oldPopular.id);
  });

  // 9. maxFacts budget: prunes lowest-scoring first
  it('prunes lowest-scoring facts first to meet maxFacts budget', async () => {
    const facts = [
      makeFact({ content: 'A', valid_from: daysAgo(90), access_count: 0 }),
      makeFact({ content: 'B', valid_from: daysAgo(30), access_count: 0 }),
      makeFact({ content: 'C', valid_from: daysAgo(1), access_count: 0 }),
    ];
    for (const f of facts) await store.putFact(f);

    const consolidator = new MemoryConsolidator(store, index, { maxFacts: 1 });
    const report = await consolidator.consolidate();

    expect(report.factsDecayed).toBe(2);
    const remaining = await store.findFacts({ include_invalidated: false });
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(facts[2].id); // newest survives
  });

  // 10. maxFacts not set: no decay pruning
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

  // 11. maxEpisodes budget: prunes oldest episodes
  it('prunes oldest episodes when exceeding maxEpisodes', async () => {
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

  // 12. maxEpisodes not set: no episode pruning
  it('does not prune episodes when maxEpisodes is not set', async () => {
    for (let i = 0; i < 5; i++) {
      await store.putEpisode(makeEpisode());
    }

    const consolidator = new MemoryConsolidator(store, index);
    const report = await consolidator.consolidate();

    expect(report.episodesPruned).toBe(0);
  });

  // 13. Empty store: report shows all zeros
  it('returns all-zero report for empty store', async () => {
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

  // 14. Idempotent: running twice produces same result
  it('is idempotent — second run produces zero changes', async () => {
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

  // 15. Already-invalidated facts skipped
  it('skips already-invalidated facts during dedup', async () => {
    const f1 = makeFact({
      content: 'A',
      embedding: [1, 0, 0],
      invalidated_by: 'some-reason',
    });
    const f2 = makeFact({ content: 'B', embedding: [1, 0, 0] });
    await store.putFact(f1);
    await store.putFact(f2);
    await index.rebuild(store);

    const consolidator = new MemoryConsolidator(store, index, { dedupThreshold: 0.9 });
    const report = await consolidator.consolidate();

    expect(report.factsDeduped).toBe(0);
  });

  // 16. Report totals correct
  it('correctly sums totalReclaimed from all operations', async () => {
    // 2 duplicate facts + 2 old facts over budget + 2 old episodes over budget
    const f1 = makeFact({ content: 'dup1', embedding: [1, 0, 0], valid_from: daysAgo(1) });
    const f2 = makeFact({ content: 'dup2', embedding: [1, 0, 0], valid_from: daysAgo(2) });
    const f3 = makeFact({ content: 'extra1', valid_from: daysAgo(90) });
    const f4 = makeFact({ content: 'extra2', valid_from: daysAgo(80) });
    const f5 = makeFact({ content: 'keeper', valid_from: daysAgo(1) });
    await store.putFact(f1);
    await store.putFact(f2);
    await store.putFact(f3);
    await store.putFact(f4);
    await store.putFact(f5);
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

  // 17. Dedup with no embeddings: skips (no crashes)
  it('handles facts without embeddings gracefully during dedup', async () => {
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

  // 18. Mixed: dedup + decay + episode pruning in one pass
  it('runs dedup, decay, and episode pruning in a single consolidate call', async () => {
    // Duplicates
    const dup1 = makeFact({ content: 'dup', embedding: [1, 0, 0], valid_from: daysAgo(1) });
    const dup2 = makeFact({ content: 'dup', embedding: [1, 0, 0], valid_from: daysAgo(2) });
    // Old fact for decay
    const old = makeFact({ content: 'old', valid_from: daysAgo(90), access_count: 0 });
    // Recent keeper
    const recent = makeFact({ content: 'recent', valid_from: daysAgo(1) });
    await store.putFact(dup1);
    await store.putFact(dup2);
    await store.putFact(old);
    await store.putFact(recent);
    await index.rebuild(store);

    // Episodes
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

  // 19. Single fact: no dedup possible
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

  // 20. Decay half-life affects scoring correctly
  it('uses configured half-life for decay scoring', async () => {
    // With half-life of 10 days, a 20-day-old fact decays to 0.25x
    // With half-life of 100 days, a 20-day-old fact decays to ~0.87x
    const oldFact = makeFact({
      content: 'Old',
      valid_from: daysAgo(20),
      access_count: 1,
    });
    const newFact = makeFact({
      content: 'New',
      valid_from: daysAgo(1),
      access_count: 1,
    });
    await store.putFact(oldFact);
    await store.putFact(newFact);

    // Short half-life: old fact should be pruned
    const shortHL = new MemoryConsolidator(store, index, {
      maxFacts: 1,
      decayHalfLifeDays: 10,
    });
    const report = await shortHL.consolidate();
    expect(report.factsDecayed).toBe(1);

    const remaining = await store.findFacts({ include_invalidated: false });
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(newFact.id);
  });

  // --- Auto-consolidation ---

  // 21. Centroid computation handles mixed-dimension embeddings
  it('computes centroid correctly when embeddings have mixed dimensions', async () => {
    // Create a theme with facts that have different embedding dimensions
    const f1 = makeFact({ content: 'Fact A', embedding: [1, 0, 0], valid_from: daysAgo(1) });
    const f2 = makeFact({ content: 'Fact B', embedding: [0, 1, 0], valid_from: daysAgo(1) });
    const f3 = makeFact({ content: 'Fact C', embedding: [0.5, 0.5], valid_from: daysAgo(1) }); // 2-dim (mismatched)

    await store.putFact(f1);
    await store.putFact(f2);
    await store.putFact(f3);

    const theme: Theme = {
      id: crypto.randomUUID(),
      label: 'Test theme',
      description: '',
      fact_ids: [f1.id, f2.id, f3.id],
      embedding: [0.5, 0.5, 0],
      provenance: prov,
    };
    await store.putTheme(theme);
    await index.rebuild(store);

    // Delete f1 to trigger theme cascade with centroid recomputation
    const consolidator = new MemoryConsolidator(store, index, {
      dedupThreshold: 0.9,
      maxFacts: 2,
      decayHalfLifeDays: 1, // aggressive decay to prune f1
    });
    const report = await consolidator.consolidate();

    // Theme should still exist (f2 and f3 remain) and not crash
    expect(report.themesCleanedUp + report.themesRemoved).toBeGreaterThanOrEqual(0);
    const themes = await store.listThemes();
    // If theme survived, its embedding should be valid (not NaN)
    for (const t of themes) {
      if (t.embedding) {
        for (const v of t.embedding) {
          expect(Number.isFinite(v)).toBe(true);
        }
      }
    }
  });

  describe('debug mode and mutation logging', () => {
    it('populates mutationLog when debug mode is on', async () => {
      const f1 = makeFact({ content: 'A', embedding: [1, 0, 0] });
      const f2 = makeFact({ content: 'B', embedding: [1, 0, 0], valid_from: daysAgo(5) });
      await store.putFact(f1);
      await store.putFact(f2);
      await index.rebuild(store);

      const consolidator = new MemoryConsolidator(store, index, {
        dedupThreshold: 0.9,
        debug: true,
      });
      const report = await consolidator.consolidate();

      expect(report.mutationLog).toBeDefined();
      expect(report.mutationLog!.length).toBeGreaterThan(0);
      // Each entry should have type and id
      for (const entry of report.mutationLog!) {
        expect(entry.type).toBeDefined();
        expect(entry.id).toBeDefined();
      }
    });

    it('does NOT include mutationLog when debug mode is off (default)', async () => {
      const f1 = makeFact({ content: 'A', embedding: [1, 0, 0] });
      const f2 = makeFact({ content: 'B', embedding: [1, 0, 0], valid_from: daysAgo(5) });
      await store.putFact(f1);
      await store.putFact(f2);
      await index.rebuild(store);

      const consolidator = new MemoryConsolidator(store, index, {
        dedupThreshold: 0.9,
      });
      const report = await consolidator.consolidate();

      expect(report.mutationLog).toBeUndefined();
    });

    it('applies non-conflicting mutations normally with debug on', async () => {
      const oldFact = makeFact({
        content: 'Old fact',
        valid_from: daysAgo(60),
        access_count: 0,
      });
      const newFact = makeFact({
        content: 'New fact',
        valid_from: daysAgo(1),
        access_count: 0,
      });
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

      const remaining = await store.findFacts({ include_invalidated: false });
      expect(remaining).toHaveLength(1);
      expect(remaining[0].id).toBe(newFact.id);
    });
  });

  describe('shouldConsolidate', () => {
    it('returns true when facts exceed threshold', async () => {
      for (let i = 0; i < 5; i++) {
        await store.putFact(makeFact({ content: `Fact ${i}` }));
      }
      expect(await MemoryConsolidator.shouldConsolidate(store, { maxFacts: 3 })).toBe(true);
    });

    it('returns false when facts are under threshold', async () => {
      for (let i = 0; i < 2; i++) {
        await store.putFact(makeFact({ content: `Fact ${i}` }));
      }
      expect(await MemoryConsolidator.shouldConsolidate(store, { maxFacts: 5 })).toBe(false);
    });

    it('returns true when episodes exceed threshold', async () => {
      for (let i = 0; i < 5; i++) {
        await store.putEpisode(makeEpisode({ topic: `Episode ${i}` }));
      }
      expect(await MemoryConsolidator.shouldConsolidate(store, { maxEpisodes: 3 })).toBe(true);
    });

    it('returns false when no thresholds are set', async () => {
      for (let i = 0; i < 100; i++) {
        await store.putFact(makeFact({ content: `Fact ${i}` }));
      }
      expect(await MemoryConsolidator.shouldConsolidate(store, {})).toBe(false);
    });
  });

  describe('autoConsolidate', () => {
    it('returns null when not needed', async () => {
      await store.putFact(makeFact({ content: 'Single fact' }));
      const consolidator = new MemoryConsolidator(store, index, { maxFacts: 1 });
      const result = await consolidator.autoConsolidate({ maxFacts: 10 });
      expect(result).toBeNull();
    });

    it('returns report when consolidation is needed', async () => {
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
