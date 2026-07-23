/**
 * DrizzleMemoryStore Tests
 *
 * Integration tests against a real Postgres instance with pgvector.
 * Skipped automatically when DATABASE_URL is not set.
 */

import { describe, test, expect } from 'vitest';
import { setupDatabaseTests, isDatabaseAvailable } from './setup.js';
import { DrizzleMemoryStore } from '../src/drizzle-memory-store.js';
import { randomUUID } from 'node:crypto';
import type { Entity, Relationship, Episode, SemanticFact, Theme, Provenance } from '@cycgraph/memory';

function makeProv(overrides: Partial<Provenance> = {}): Provenance {
  return {
    source: 'system',
    confidence: 1,
    created_at: new Date(),
    ...overrides,
  };
}

function makeEntity(overrides: Partial<Entity> = {}): Entity {
  const now = new Date();
  return {
    id: randomUUID(),
    name: 'Test Entity',
    entity_type: 'concept',
    attributes: {},
    provenance: makeProv(),
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function makeRelationship(sourceId: string, targetId: string, overrides: Partial<Relationship> = {}): Relationship {
  return {
    id: randomUUID(),
    source_id: sourceId,
    target_id: targetId,
    relation_type: 'related_to',
    weight: 1,
    attributes: {},
    valid_from: new Date(),
    provenance: makeProv(),
    ...overrides,
  };
}

function makeEpisode(overrides: Partial<Episode> = {}): Episode {
  const now = new Date();
  return {
    id: randomUUID(),
    topic: 'Test Topic',
    messages: [
      {
        id: randomUUID(),
        role: 'user',
        content: 'Hello',
        timestamp: now,
        metadata: {},
      },
    ],
    started_at: now,
    ended_at: now,
    fact_ids: [],
    provenance: makeProv(),
    ...overrides,
  };
}

function makeFact(overrides: Partial<SemanticFact> = {}): SemanticFact {
  return {
    id: randomUUID(),
    content: 'Alice works at Acme Corp',
    source_episode_ids: [],
    entity_ids: [],
    provenance: makeProv(),
    valid_from: new Date(),
    access_count: 0,
    ...overrides,
  };
}

function makeTheme(overrides: Partial<Theme> = {}): Theme {
  return {
    id: randomUUID(),
    label: 'Test Theme',
    description: 'A test theme',
    fact_ids: [],
    provenance: makeProv(),
    ...overrides,
  };
}

describe.skipIf(!isDatabaseAvailable())('DrizzleMemoryStore', () => {
  setupDatabaseTests();

  const store = new DrizzleMemoryStore();

  // ── Entity Operations ──

  test('putEntity and getEntity round-trip', async () => {
    const entity = makeEntity({ name: 'Alice', entity_type: 'person' });
    await store.putEntity(entity);

    const loaded = await store.getEntity(entity.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.name).toBe('Alice');
    expect(loaded!.entity_type).toBe('person');
    expect(loaded!.provenance.source).toBe('system');
  });

  test('getEntity returns null for missing ID', async () => {
    const loaded = await store.getEntity(randomUUID());
    expect(loaded).toBeNull();
  });

  test('putEntity upserts on duplicate ID', async () => {
    const entity = makeEntity({ name: 'Original' });
    await store.putEntity(entity);

    const updated = { ...entity, name: 'Updated', updated_at: new Date() };
    await store.putEntity(updated);

    const loaded = await store.getEntity(entity.id);
    expect(loaded!.name).toBe('Updated');
  });

  test('findEntities with type filter', async () => {
    await store.putEntity(makeEntity({ entity_type: 'person' }));
    await store.putEntity(makeEntity({ entity_type: 'organization' }));
    await store.putEntity(makeEntity({ entity_type: 'person' }));

    const people = await store.findEntities({ entityType: 'person' });
    expect(people).toHaveLength(2);
    expect(people.every(e => e.entity_type === 'person')).toBe(true);
  });

  test('findEntities excludes invalidated by default', async () => {
    await store.putEntity(makeEntity({ entity_type: 'concept' }));
    await store.putEntity(makeEntity({ entity_type: 'concept', invalidated_at: new Date() }));

    const results = await store.findEntities({ entityType: 'concept' });
    expect(results).toHaveLength(1);
  });

  test('findEntities with include_invalidated', async () => {
    await store.putEntity(makeEntity({ entity_type: 'concept' }));
    await store.putEntity(makeEntity({ entity_type: 'concept', invalidated_at: new Date() }));

    const results = await store.findEntities({ entityType: 'concept', includeInvalidated: true });
    expect(results).toHaveLength(2);
  });

  test('deleteEntity removes entity', async () => {
    const entity = makeEntity();
    await store.putEntity(entity);
    expect(await store.getEntity(entity.id)).not.toBeNull();

    const deleted = await store.deleteEntity(entity.id);
    expect(deleted).toBe(true);
    expect(await store.getEntity(entity.id)).toBeNull();
  });

  // ── Relationship Operations ──

  test('putRelationship and getRelationship', async () => {
    const e1 = makeEntity();
    const e2 = makeEntity();
    await store.putEntity(e1);
    await store.putEntity(e2);

    const rel = makeRelationship(e1.id, e2.id, { relation_type: 'works_at' });
    await store.putRelationship(rel);

    const loaded = await store.getRelationship(rel.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.relation_type).toBe('works_at');
    expect(loaded!.source_id).toBe(e1.id);
    expect(loaded!.target_id).toBe(e2.id);
  });

  test('getRelationshipsForEntity with direction filter', async () => {
    const e1 = makeEntity();
    const e2 = makeEntity();
    const e3 = makeEntity();
    await store.putEntity(e1);
    await store.putEntity(e2);
    await store.putEntity(e3);

    await store.putRelationship(makeRelationship(e1.id, e2.id));
    await store.putRelationship(makeRelationship(e3.id, e1.id));

    const outgoing = await store.getRelationshipsForEntity(e1.id, { direction: 'outgoing' });
    expect(outgoing).toHaveLength(1);
    expect(outgoing[0].target_id).toBe(e2.id);

    const incoming = await store.getRelationshipsForEntity(e1.id, { direction: 'incoming' });
    expect(incoming).toHaveLength(1);
    expect(incoming[0].source_id).toBe(e3.id);

    const both = await store.getRelationshipsForEntity(e1.id, { direction: 'both' });
    expect(both).toHaveLength(2);
  });

  // ── Episode Operations ──

  test('putEpisode and getEpisode', async () => {
    const ep = makeEpisode({ topic: 'Architecture Discussion' });
    await store.putEpisode(ep);

    const loaded = await store.getEpisode(ep.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.topic).toBe('Architecture Discussion');
    expect(loaded!.messages).toHaveLength(1);
  });

  test('listEpisodes with pagination', async () => {
    for (let i = 0; i < 5; i++) {
      await store.putEpisode(makeEpisode({
        started_at: new Date(Date.now() - i * 1000),
        ended_at: new Date(Date.now() - i * 1000),
      }));
    }

    const page1 = await store.listEpisodes({ limit: 3, offset: 0 });
    expect(page1).toHaveLength(3);

    const page2 = await store.listEpisodes({ limit: 3, offset: 3 });
    expect(page2).toHaveLength(2);
  });

  // ── Semantic Fact Operations ──

  test('putFact and getFact', async () => {
    const fact = makeFact({ content: 'Bob leads engineering' });
    await store.putFact(fact);

    const loaded = await store.getFact(fact.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.content).toBe('Bob leads engineering');
  });

  test('touchFacts increments access_count and sets last_accessed_at; missing ids ignored', async () => {
    const fact = makeFact({ access_count: 0 });
    await store.putFact(fact);
    const at = new Date('2026-01-01T00:00:00Z');

    await store.touchFacts([fact.id, randomUUID()], at);
    await store.touchFacts([fact.id], at);

    const touched = await store.getFact(fact.id);
    expect(touched!.access_count).toBe(2);
    expect(touched!.last_accessed_at).toEqual(at);
  });

  test('findFacts with theme_id filter', async () => {
    const theme = makeTheme();
    await store.putTheme(theme);

    await store.putFact(makeFact({ theme_id: theme.id }));
    await store.putFact(makeFact({ theme_id: theme.id }));
    await store.putFact(makeFact());

    const results = await store.findFacts({ themeId: theme.id });
    expect(results).toHaveLength(2);
  });

  test('findFacts with entity_id filter (uses join table)', async () => {
    const entity = makeEntity();
    await store.putEntity(entity);

    const fact1 = makeFact({ entity_ids: [entity.id] });
    const fact2 = makeFact({ entity_ids: [entity.id] });
    const fact3 = makeFact({ entity_ids: [] });
    await store.putFact(fact1);
    await store.putFact(fact2);
    await store.putFact(fact3);

    const results = await store.findFacts({ entityId: entity.id });
    expect(results).toHaveLength(2);
  });

  test('putFact updates join table on upsert', async () => {
    const e1 = makeEntity();
    const e2 = makeEntity();
    await store.putEntity(e1);
    await store.putEntity(e2);

    const fact = makeFact({ entity_ids: [e1.id] });
    await store.putFact(fact);

    let byE1 = await store.findFacts({ entityId: e1.id });
    expect(byE1).toHaveLength(1);

    // Update entity_ids to point to e2 instead
    await store.putFact({ ...fact, entity_ids: [e2.id] });

    byE1 = await store.findFacts({ entityId: e1.id });
    expect(byE1).toHaveLength(0);

    const byE2 = await store.findFacts({ entityId: e2.id });
    expect(byE2).toHaveLength(1);
  });

  // ── Theme Operations ──

  test('putTheme and getTheme', async () => {
    const theme = makeTheme({ label: 'Architecture' });
    await store.putTheme(theme);

    const loaded = await store.getTheme(theme.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.label).toBe('Architecture');
  });

  test('listThemes', async () => {
    await store.putTheme(makeTheme({ label: 'Theme A' }));
    await store.putTheme(makeTheme({ label: 'Theme B' }));

    const themes = await store.listThemes();
    expect(themes).toHaveLength(2);
  });

  // ── Batch Operations ──

  test('batch getEntities with multiple IDs', async () => {
    const e1 = makeEntity({ name: 'E1' });
    const e2 = makeEntity({ name: 'E2' });
    await store.putEntity(e1);
    await store.putEntity(e2);

    const result = await store.getEntities([e1.id, e2.id]);
    expect(result.size).toBe(2);
    expect(result.get(e1.id)!.name).toBe('E1');
    expect(result.get(e2.id)!.name).toBe('E2');
  });

  test('batch getFacts with missing IDs silently absent', async () => {
    const fact = makeFact();
    await store.putFact(fact);

    const result = await store.getFacts([fact.id, randomUUID()]);
    expect(result.size).toBe(1);
    expect(result.has(fact.id)).toBe(true);
  });

  // ── Lifecycle ──

  test('clear() removes all data', async () => {
    await store.putEntity(makeEntity());
    await store.putTheme(makeTheme());
    await store.putEpisode(makeEpisode());
    await store.putFact(makeFact());

    await store.clear();

    expect(await store.findEntities()).toHaveLength(0);
    expect(await store.listThemes()).toHaveLength(0);
    expect(await store.listEpisodes()).toHaveLength(0);
    expect(await store.findFacts()).toHaveLength(0);
  });
});
