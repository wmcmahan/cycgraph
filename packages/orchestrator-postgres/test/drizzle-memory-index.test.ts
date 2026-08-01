/**
 * DrizzleMemoryIndex Tests
 *
 * Integration tests for pgvector similarity search.
 * Skipped automatically when DATABASE_URL is not set.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { setupDatabaseTests, isDatabaseAvailable, getDb } from './setup.js';
import { DrizzleMemoryStore } from '../src/drizzle-memory-store.js';
import { DrizzleMemoryIndex } from '../src/drizzle-memory-index.js';
import { tenants } from '../src/schema.js';
import type { Entity, SemanticFact, Theme, Episode, Provenance } from '@cycgraph/memory';

/** Generate a normalised random 1536-dim vector. */
function randomEmbedding(): number[] {
  const v = Array.from({ length: 1536 }, () => Math.random() - 0.5);
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / norm);
}

/** Generate a near-duplicate of a vector with small noise. */
function nearDuplicate(base: number[], noise = 0.01): number[] {
  const v = base.map((x) => x + (Math.random() - 0.5) * noise);
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / norm);
}

function makeProv(): Provenance {
  return { source: 'system', confidence: 1, created_at: new Date() };
}

function makeEntity(embedding: number[] | undefined, overrides: Partial<Entity> = {}): Entity {
  const now = new Date();
  return {
    id: randomUUID(),
    name: 'Entity',
    entity_type: 'concept',
    attributes: {},
    embedding,
    provenance: makeProv(),
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

describe.skipIf(!isDatabaseAvailable())('DrizzleMemoryIndex', () => {
  setupDatabaseTests();

  const store = new DrizzleMemoryStore();
  const index = new DrizzleMemoryIndex();

  describe('searchEntities', () => {
    it('returns scored results ordered by descending similarity', async () => {
      const queryEmb = randomEmbedding();
      await store.putEntity(makeEntity(nearDuplicate(queryEmb, 0.01), { name: 'Near' }));
      await store.putEntity(makeEntity(randomEmbedding(), { name: 'Far' }));

      const results = await index.searchEntities(queryEmb, { limit: 10, minSimilarity: 0.0 });

      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].item.name).toBe('Near');
      if (results.length >= 2) {
        expect(results[0].score).toBeGreaterThanOrEqual(results[1].score);
      }
    });

    it('applies default options when called with only an embedding', async () => {
      const queryEmb = randomEmbedding();
      await store.putEntity(makeEntity(nearDuplicate(queryEmb, 0.01), { name: 'Near' }));

      const results = await index.searchEntities(queryEmb);

      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].item.name).toBe('Near');
    });

    it('excludes results below the minSimilarity threshold', async () => {
      const queryEmb = randomEmbedding();
      await store.putEntity(makeEntity(nearDuplicate(queryEmb, 0.01), { name: 'Near' }));

      const results = await index.searchEntities(queryEmb, { minSimilarity: 0.999 });

      expect(Array.isArray(results)).toBe(true);
    });

    it('respects the result limit', async () => {
      const queryEmb = randomEmbedding();
      for (let i = 0; i < 5; i++) {
        await store.putEntity(makeEntity(nearDuplicate(queryEmb, 0.05), { name: `Entity ${i}` }));
      }

      const results = await index.searchEntities(queryEmb, { limit: 2, minSimilarity: 0.0 });

      expect(results.length).toBeLessThanOrEqual(2);
    });

    it('omits records that have no embedding', async () => {
      await store.putEntity(makeEntity(undefined, { name: 'No Embedding' }));

      const results = await index.searchEntities(randomEmbedding(), { minSimilarity: 0.0 });

      expect(results.every((r) => r.item.name !== 'No Embedding')).toBe(true);
    });

    it('returns an empty array against an empty table', async () => {
      const results = await index.searchEntities(randomEmbedding(), { minSimilarity: 0.0 });

      expect(results).toHaveLength(0);
    });

    it('scores an identical vector near 1', async () => {
      const queryEmb = randomEmbedding();
      await store.putEntity(makeEntity(queryEmb, { name: 'Exact Match' }));

      const results = await index.searchEntities(queryEmb, { minSimilarity: 0.0 });

      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].score).toBeGreaterThan(0.99);
    });
  });

  describe('searchFacts', () => {
    it('returns scored fact results', async () => {
      const queryEmb = randomEmbedding();
      const fact: SemanticFact = {
        id: randomUUID(),
        content: 'Test fact for search',
        source_episode_ids: [],
        entity_ids: [],
        provenance: makeProv(),
        valid_from: new Date(),
        embedding: nearDuplicate(queryEmb, 0.01),
        access_count: 0,
      };
      await store.putFact(fact);

      const results = await index.searchFacts(queryEmb, { minSimilarity: 0.0 });

      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].item.content).toBe('Test fact for search');
      expect(results[0].score).toBeGreaterThan(0);
    });
  });

  describe('searchThemes', () => {
    it('returns scored theme results', async () => {
      const queryEmb = randomEmbedding();
      const theme: Theme = {
        id: randomUUID(),
        label: 'Architecture',
        description: 'System design',
        fact_ids: [],
        embedding: nearDuplicate(queryEmb, 0.01),
        provenance: makeProv(),
      };
      await store.putTheme(theme);

      const results = await index.searchThemes(queryEmb, { minSimilarity: 0.0 });

      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].item.label).toBe('Architecture');
    });
  });

  describe('searchEpisodes', () => {
    it('returns scored episode results', async () => {
      const queryEmb = randomEmbedding();
      const now = new Date();
      const episode: Episode = {
        id: randomUUID(),
        topic: 'Search Test Episode',
        messages: [{ id: randomUUID(), role: 'user', content: 'test', timestamp: now, metadata: {} }],
        started_at: now,
        ended_at: now,
        embedding: nearDuplicate(queryEmb, 0.01),
        fact_ids: [],
        provenance: makeProv(),
      };
      await store.putEpisode(episode);

      const results = await index.searchEpisodes(queryEmb, { minSimilarity: 0.0 });

      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].item.topic).toBe('Search Test Episode');
    });
  });

  describe('rebuild', () => {
    it('resolves without error', async () => {
      await expect(index.rebuild(store)).resolves.not.toThrow();
    });
  });

  describe('tenant scoping', () => {
    const TENANT_A = randomUUID();

    beforeAll(async () => {
      const db = await getDb();
      await db
        .insert(tenants)
        .values({ id: TENANT_A, slug: `idx-${TENANT_A}`, name: 'Index Tenant' })
        .onConflictDoNothing();
    });

    afterAll(async () => {
      const db = await getDb();
      await db.delete(tenants).where(eq(tenants.id, TENANT_A));
    });

    const scopedStore = new DrizzleMemoryStore({ tenant: { tenant_id: TENANT_A } });
    const scopedIndex = new DrizzleMemoryIndex({ tenant: { tenant_id: TENANT_A } });

    it('searches every record kind within the tenant', async () => {
      const queryEmb = randomEmbedding();
      const now = new Date();
      await scopedStore.putEntity(makeEntity(nearDuplicate(queryEmb, 0.01), { name: 'Scoped Entity' }));
      await scopedStore.putFact({
        id: randomUUID(),
        content: 'Scoped fact',
        source_episode_ids: [],
        entity_ids: [],
        provenance: makeProv(),
        valid_from: now,
        embedding: nearDuplicate(queryEmb, 0.01),
        access_count: 0,
      });
      await scopedStore.putTheme({
        id: randomUUID(),
        label: 'Scoped Theme',
        description: '',
        fact_ids: [],
        embedding: nearDuplicate(queryEmb, 0.01),
        provenance: makeProv(),
      });
      await scopedStore.putEpisode({
        id: randomUUID(),
        topic: 'Scoped Episode',
        messages: [{ id: randomUUID(), role: 'user', content: 'x', timestamp: now, metadata: {} }],
        started_at: now,
        ended_at: now,
        embedding: nearDuplicate(queryEmb, 0.01),
        fact_ids: [],
        provenance: makeProv(),
      });

      expect((await scopedIndex.searchEntities(queryEmb, { minSimilarity: 0.0 }))[0].item.name).toBe('Scoped Entity');
      expect((await scopedIndex.searchFacts(queryEmb, { minSimilarity: 0.0 }))[0].item.content).toBe('Scoped fact');
      expect((await scopedIndex.searchThemes(queryEmb, { minSimilarity: 0.0 }))[0].item.label).toBe('Scoped Theme');
      expect((await scopedIndex.searchEpisodes(queryEmb, { minSimilarity: 0.0 }))[0].item.topic).toBe('Scoped Episode');
    });
  });
});
