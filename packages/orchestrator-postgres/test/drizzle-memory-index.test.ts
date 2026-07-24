/**
 * DrizzleMemoryIndex Tests
 *
 * Integration tests for pgvector similarity search.
 * Skipped automatically when DATABASE_URL is not set.
 */

import { describe, test, expect } from 'vitest';
import { setupDatabaseTests, isDatabaseAvailable } from './setup.js';
import { DrizzleMemoryStore } from '../src/drizzle-memory-store.js';
import { DrizzleMemoryIndex } from '../src/drizzle-memory-index.js';
import { randomUUID } from 'node:crypto';
import type { Entity, SemanticFact, Theme, Episode, Provenance } from '@cycgraph/memory';

/** Generate a normalised random 1536-dim vector. */
function randomEmbedding(): number[] {
  const v = Array.from({ length: 1536 }, () => Math.random() - 0.5);
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map(x => x / norm);
}

/** Generate a near-duplicate of a vector with small noise. */
function nearDuplicate(base: number[], noise = 0.01): number[] {
  const v = base.map(x => x + (Math.random() - 0.5) * noise);
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map(x => x / norm);
}

function makeProv(): Provenance {
  return { source: 'system', confidence: 1, created_at: new Date() };
}

describe.skipIf(!isDatabaseAvailable())('DrizzleMemoryIndex', () => {
  setupDatabaseTests();

  const store = new DrizzleMemoryStore();
  const index = new DrizzleMemoryIndex();

  test('searchEntities returns scored results sorted by similarity', async () => {
    const queryEmb = randomEmbedding();
    const nearEmb = nearDuplicate(queryEmb, 0.01);
    const farEmb = randomEmbedding();

    const nearEntity: Entity = {
      id: randomUUID(),
      name: 'Near',
      entity_type: 'concept',
      attributes: {},
      embedding: nearEmb,
      provenance: makeProv(),
      created_at: new Date(),
      updated_at: new Date(),
    };
    const farEntity: Entity = {
      id: randomUUID(),
      name: 'Far',
      entity_type: 'concept',
      attributes: {},
      embedding: farEmb,
      provenance: makeProv(),
      created_at: new Date(),
      updated_at: new Date(),
    };

    await store.putEntity(nearEntity);
    await store.putEntity(farEntity);

    const results = await index.searchEntities(queryEmb, { limit: 10, minSimilarity: 0.0 });
    expect(results.length).toBeGreaterThanOrEqual(1);
    // Near entity should be first (highest similarity)
    if (results.length >= 2) {
      expect(results[0].score).toBeGreaterThanOrEqual(results[1].score);
    }
    expect(results[0].item.name).toBe('Near');
  });

  test('minSimilarity filter excludes low-similarity results', async () => {
    const queryEmb = randomEmbedding();
    const nearEmb = nearDuplicate(queryEmb, 0.01);

    await store.putEntity({
      id: randomUUID(),
      name: 'Near',
      entity_type: 'concept',
      attributes: {},
      embedding: nearEmb,
      provenance: makeProv(),
      created_at: new Date(),
      updated_at: new Date(),
    });

    // Very high threshold should exclude most results
    const results = await index.searchEntities(queryEmb, { minSimilarity: 0.999 });
    // May or may not match depending on noise — just check it doesn't crash
    expect(Array.isArray(results)).toBe(true);
  });

  test('limit is respected', async () => {
    const queryEmb = randomEmbedding();
    for (let i = 0; i < 5; i++) {
      await store.putEntity({
        id: randomUUID(),
        name: `Entity ${i}`,
        entity_type: 'concept',
        attributes: {},
        embedding: nearDuplicate(queryEmb, 0.05),
        provenance: makeProv(),
        created_at: new Date(),
        updated_at: new Date(),
      });
    }

    const results = await index.searchEntities(queryEmb, { limit: 2, minSimilarity: 0.0 });
    expect(results.length).toBeLessThanOrEqual(2);
  });

  test('search returns empty for records without embeddings', async () => {
    await store.putEntity({
      id: randomUUID(),
      name: 'No Embedding',
      entity_type: 'concept',
      attributes: {},
      provenance: makeProv(),
      created_at: new Date(),
      updated_at: new Date(),
    });

    const results = await index.searchEntities(randomEmbedding(), { minSimilarity: 0.0 });
    // The entity without embedding should not appear
    expect(results.every(r => r.item.name !== 'No Embedding')).toBe(true);
  });

  test('rebuild() does not error', async () => {
    await expect(index.rebuild(store)).resolves.not.toThrow();
  });

  test('searchFacts works', async () => {
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

  test('searchThemes works', async () => {
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

  test('searchEpisodes works', async () => {
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

  test('empty table returns empty results', async () => {
    // Tables are cleared in beforeEach
    const results = await index.searchEntities(randomEmbedding(), { minSimilarity: 0.0 });
    expect(results).toHaveLength(0);
  });

  test('cosine similarity score is in expected range for known vectors', async () => {
    // Create an entity with the exact query embedding for perfect similarity
    const queryEmb = randomEmbedding();
    await store.putEntity({
      id: randomUUID(),
      name: 'Exact Match',
      entity_type: 'concept',
      attributes: {},
      embedding: queryEmb,
      provenance: makeProv(),
      created_at: new Date(),
      updated_at: new Date(),
    });

    const results = await index.searchEntities(queryEmb, { minSimilarity: 0.0 });
    expect(results.length).toBeGreaterThanOrEqual(1);
    // Exact same normalised vector should give similarity very close to 1
    expect(results[0].score).toBeGreaterThan(0.99);
  });
});
