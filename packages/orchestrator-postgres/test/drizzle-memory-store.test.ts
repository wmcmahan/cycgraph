/**
 * DrizzleMemoryStore Tests
 *
 * Integration tests against a real Postgres instance with pgvector.
 * Skipped automatically when DATABASE_URL is not set.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { setupDatabaseTests, isDatabaseAvailable, getDb } from './setup.js';
import { DrizzleMemoryStore } from '../src/drizzle-memory-store.js';
import { tenants } from '../src/schema.js';
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

  describe('entity operations', () => {
    it('round-trips an entity through putEntity and getEntity', async () => {
      const entity = makeEntity({ name: 'Alice', entity_type: 'person' });

      await store.putEntity(entity);

      const loaded = await store.getEntity(entity.id);
      expect(loaded).not.toBeNull();
      expect(loaded!.name).toBe('Alice');
      expect(loaded!.entity_type).toBe('person');
      expect(loaded!.provenance.source).toBe('system');
    });

    it('returns null from getEntity for a missing id', async () => {
      expect(await store.getEntity(randomUUID())).toBeNull();
    });

    it('upserts an entity on a duplicate id', async () => {
      const entity = makeEntity({ name: 'Original' });
      await store.putEntity(entity);

      await store.putEntity({ ...entity, name: 'Updated', updated_at: new Date() });

      const loaded = await store.getEntity(entity.id);
      expect(loaded!.name).toBe('Updated');
    });

    it('findEntities filters by entity type', async () => {
      await store.putEntity(makeEntity({ entity_type: 'person' }));
      await store.putEntity(makeEntity({ entity_type: 'organization' }));
      await store.putEntity(makeEntity({ entity_type: 'person' }));

      const people = await store.findEntities({ entityType: 'person' });

      expect(people).toHaveLength(2);
      expect(people.every((e) => e.entity_type === 'person')).toBe(true);
    });

    it('findEntities excludes invalidated entities by default', async () => {
      await store.putEntity(makeEntity({ entity_type: 'concept' }));
      await store.putEntity(makeEntity({ entity_type: 'concept', invalidated_at: new Date() }));

      const results = await store.findEntities({ entityType: 'concept' });

      expect(results).toHaveLength(1);
    });

    it('findEntities includes invalidated entities when asked', async () => {
      await store.putEntity(makeEntity({ entity_type: 'concept' }));
      await store.putEntity(makeEntity({ entity_type: 'concept', invalidated_at: new Date() }));

      const results = await store.findEntities({ entityType: 'concept', includeInvalidated: true });

      expect(results).toHaveLength(2);
    });

    it('findEntities paginates with limit and offset', async () => {
      for (let i = 0; i < 5; i++) {
        await store.putEntity(makeEntity({ entity_type: 'paged' }));
      }

      const page1 = await store.findEntities({ entityType: 'paged', limit: 3, offset: 0 });
      const page2 = await store.findEntities({ entityType: 'paged', limit: 3, offset: 3 });

      expect(page1).toHaveLength(3);
      expect(page2).toHaveLength(2);
    });

    it('deleteEntity removes an existing entity and reports true', async () => {
      const entity = makeEntity();
      await store.putEntity(entity);

      const deleted = await store.deleteEntity(entity.id);

      expect(deleted).toBe(true);
      expect(await store.getEntity(entity.id)).toBeNull();
    });

    it('deleteEntity reports false for a missing id', async () => {
      expect(await store.deleteEntity(randomUUID())).toBe(false);
    });
  });

  describe('relationship operations', () => {
    it('round-trips a relationship through putRelationship and getRelationship', async () => {
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

    it('returns null from getRelationship for a missing id', async () => {
      expect(await store.getRelationship(randomUUID())).toBeNull();
    });

    it('upserts a relationship on a duplicate id', async () => {
      const e1 = makeEntity();
      const e2 = makeEntity();
      await store.putEntity(e1);
      await store.putEntity(e2);
      const rel = makeRelationship(e1.id, e2.id, { weight: 1 });
      await store.putRelationship(rel);

      await store.putRelationship({ ...rel, weight: 0.25 });

      const loaded = await store.getRelationship(rel.id);
      expect(loaded!.weight).toBe(0.25);
    });

    it('getRelationshipsForEntity filters by direction', async () => {
      const e1 = makeEntity();
      const e2 = makeEntity();
      const e3 = makeEntity();
      await store.putEntity(e1);
      await store.putEntity(e2);
      await store.putEntity(e3);
      await store.putRelationship(makeRelationship(e1.id, e2.id));
      await store.putRelationship(makeRelationship(e3.id, e1.id));

      const outgoing = await store.getRelationshipsForEntity(e1.id, { direction: 'outgoing' });
      const incoming = await store.getRelationshipsForEntity(e1.id, { direction: 'incoming' });
      const both = await store.getRelationshipsForEntity(e1.id, { direction: 'both' });

      expect(outgoing).toHaveLength(1);
      expect(outgoing[0].target_id).toBe(e2.id);
      expect(incoming).toHaveLength(1);
      expect(incoming[0].source_id).toBe(e3.id);
      expect(both).toHaveLength(2);
    });

    it('getRelationshipsForEntity filters by relation type', async () => {
      const e1 = makeEntity();
      const e2 = makeEntity();
      await store.putEntity(e1);
      await store.putEntity(e2);
      await store.putRelationship(makeRelationship(e1.id, e2.id, { relation_type: 'works_at' }));
      await store.putRelationship(makeRelationship(e1.id, e2.id, { relation_type: 'knows' }));

      const results = await store.getRelationshipsForEntity(e1.id, { relationType: 'works_at' });

      expect(results).toHaveLength(1);
      expect(results[0].relation_type).toBe('works_at');
    });

    it('getRelationshipsForEntity excludes invalidated by default and includes them when asked', async () => {
      const e1 = makeEntity();
      const e2 = makeEntity();
      await store.putEntity(e1);
      await store.putEntity(e2);
      await store.putRelationship(makeRelationship(e1.id, e2.id));
      await store.putRelationship(makeRelationship(e1.id, e2.id, { invalidated_by: 'superseded' }));

      const active = await store.getRelationshipsForEntity(e1.id, { direction: 'outgoing' });
      const all = await store.getRelationshipsForEntity(e1.id, { direction: 'outgoing', includeInvalidated: true });

      expect(active).toHaveLength(1);
      expect(all).toHaveLength(2);
    });

    it('deleteRelationship removes an existing edge and reports true', async () => {
      const e1 = makeEntity();
      const e2 = makeEntity();
      await store.putEntity(e1);
      await store.putEntity(e2);
      const rel = makeRelationship(e1.id, e2.id);
      await store.putRelationship(rel);

      const deleted = await store.deleteRelationship(rel.id);

      expect(deleted).toBe(true);
      expect(await store.getRelationship(rel.id)).toBeNull();
    });

    it('deleteRelationship reports false for a missing id', async () => {
      expect(await store.deleteRelationship(randomUUID())).toBe(false);
    });
  });

  describe('episode operations', () => {
    it('round-trips an episode through putEpisode and getEpisode', async () => {
      const ep = makeEpisode({ topic: 'Architecture Discussion' });

      await store.putEpisode(ep);

      const loaded = await store.getEpisode(ep.id);
      expect(loaded).not.toBeNull();
      expect(loaded!.topic).toBe('Architecture Discussion');
      expect(loaded!.messages).toHaveLength(1);
    });

    it('returns null from getEpisode for a missing id', async () => {
      expect(await store.getEpisode(randomUUID())).toBeNull();
    });

    it('upserts an episode on a duplicate id', async () => {
      const ep = makeEpisode({ topic: 'Original' });
      await store.putEpisode(ep);

      await store.putEpisode({ ...ep, topic: 'Revised' });

      const loaded = await store.getEpisode(ep.id);
      expect(loaded!.topic).toBe('Revised');
    });

    it('listEpisodes paginates newest-started first', async () => {
      for (let i = 0; i < 5; i++) {
        await store.putEpisode(makeEpisode({
          started_at: new Date(Date.now() - i * 1000),
          ended_at: new Date(Date.now() - i * 1000),
        }));
      }

      const page1 = await store.listEpisodes({ limit: 3, offset: 0 });
      const page2 = await store.listEpisodes({ limit: 3, offset: 3 });

      expect(page1).toHaveLength(3);
      expect(page2).toHaveLength(2);
    });

    it('deleteEpisode removes an existing episode and reports true', async () => {
      const ep = makeEpisode();
      await store.putEpisode(ep);

      const deleted = await store.deleteEpisode(ep.id);

      expect(deleted).toBe(true);
      expect(await store.getEpisode(ep.id)).toBeNull();
    });

    it('deleteEpisode reports false for a missing id', async () => {
      expect(await store.deleteEpisode(randomUUID())).toBe(false);
    });
  });

  describe('semantic fact operations', () => {
    it('round-trips a fact through putFact and getFact', async () => {
      const fact = makeFact({ content: 'Bob leads engineering' });

      await store.putFact(fact);

      const loaded = await store.getFact(fact.id);
      expect(loaded).not.toBeNull();
      expect(loaded!.content).toBe('Bob leads engineering');
    });

    it('returns null from getFact for a missing id', async () => {
      expect(await store.getFact(randomUUID())).toBeNull();
    });

    it('touchFacts increments access_count, sets last_accessed_at, and ignores missing ids', async () => {
      const fact = makeFact({ access_count: 0 });
      await store.putFact(fact);
      const at = new Date('2026-01-01T00:00:00Z');

      await store.touchFacts([fact.id, randomUUID()], at);
      await store.touchFacts([fact.id], at);

      const touched = await store.getFact(fact.id);
      expect(touched!.access_count).toBe(2);
      expect(touched!.last_accessed_at).toEqual(at);
    });

    it('touchFacts is a no-op for an empty id list', async () => {
      const fact = makeFact({ access_count: 0 });
      await store.putFact(fact);

      await store.touchFacts([]);

      expect((await store.getFact(fact.id))!.access_count).toBe(0);
    });

    it('findFacts filters by theme id', async () => {
      const theme = makeTheme();
      await store.putTheme(theme);
      await store.putFact(makeFact({ theme_id: theme.id }));
      await store.putFact(makeFact({ theme_id: theme.id }));
      await store.putFact(makeFact());

      const results = await store.findFacts({ themeId: theme.id });

      expect(results).toHaveLength(2);
    });

    it('findFacts filters by entity id through the join table', async () => {
      const entity = makeEntity();
      await store.putEntity(entity);
      await store.putFact(makeFact({ entity_ids: [entity.id] }));
      await store.putFact(makeFact({ entity_ids: [entity.id] }));
      await store.putFact(makeFact({ entity_ids: [] }));

      const results = await store.findFacts({ entityId: entity.id });

      expect(results).toHaveLength(2);
    });

    it('findFacts filters to facts sharing any requested tag', async () => {
      await store.putFact(makeFact({ tags: ['lesson', 'graph:x'] }));
      await store.putFact(makeFact({ tags: ['other'] }));

      const results = await store.findFacts({ tags: ['lesson'] });

      expect(results).toHaveLength(1);
      expect(results[0].tags).toContain('lesson');
    });

    it('findFacts excludes facts sharing any excluded tag', async () => {
      const clean = makeFact({ tags: ['clean'] });
      await store.putFact(clean);
      await store.putFact(makeFact({ tags: ['poison'] }));

      const results = await store.findFacts({ excludeTags: ['poison'] });

      expect(results.map((f) => f.id)).toEqual([clean.id]);
    });

    it('findFacts excludes invalidated facts by default and includes them when asked', async () => {
      await store.putFact(makeFact());
      await store.putFact(makeFact({ invalidated_by: 'superseded' }));

      const active = await store.findFacts();
      const all = await store.findFacts({ includeInvalidated: true });

      expect(active).toHaveLength(1);
      expect(all).toHaveLength(2);
    });

    it('putFact resyncs the entity join table on upsert', async () => {
      const e1 = makeEntity();
      const e2 = makeEntity();
      await store.putEntity(e1);
      await store.putEntity(e2);
      const fact = makeFact({ entity_ids: [e1.id] });
      await store.putFact(fact);
      expect(await store.findFacts({ entityId: e1.id })).toHaveLength(1);

      await store.putFact({ ...fact, entity_ids: [e2.id] });

      expect(await store.findFacts({ entityId: e1.id })).toHaveLength(0);
      expect(await store.findFacts({ entityId: e2.id })).toHaveLength(1);
    });

    it('deleteFact removes an existing fact and reports true', async () => {
      const fact = makeFact();
      await store.putFact(fact);

      const deleted = await store.deleteFact(fact.id);

      expect(deleted).toBe(true);
      expect(await store.getFact(fact.id)).toBeNull();
    });

    it('deleteFact reports false for a missing id', async () => {
      expect(await store.deleteFact(randomUUID())).toBe(false);
    });
  });

  describe('theme operations', () => {
    it('round-trips a theme through putTheme and getTheme', async () => {
      const theme = makeTheme({ label: 'Architecture' });

      await store.putTheme(theme);

      const loaded = await store.getTheme(theme.id);
      expect(loaded).not.toBeNull();
      expect(loaded!.label).toBe('Architecture');
    });

    it('returns null from getTheme for a missing id', async () => {
      expect(await store.getTheme(randomUUID())).toBeNull();
    });

    it('upserts a theme on a duplicate id', async () => {
      const theme = makeTheme({ label: 'Original' });
      await store.putTheme(theme);

      await store.putTheme({ ...theme, label: 'Renamed' });

      const loaded = await store.getTheme(theme.id);
      expect(loaded!.label).toBe('Renamed');
    });

    it('listThemes returns every stored theme', async () => {
      await store.putTheme(makeTheme({ label: 'Theme A' }));
      await store.putTheme(makeTheme({ label: 'Theme B' }));

      const themes = await store.listThemes();

      expect(themes).toHaveLength(2);
    });

    it('deleteTheme removes an existing theme and reports true', async () => {
      const theme = makeTheme();
      await store.putTheme(theme);

      const deleted = await store.deleteTheme(theme.id);

      expect(deleted).toBe(true);
      expect(await store.getTheme(theme.id)).toBeNull();
    });

    it('deleteTheme reports false for a missing id', async () => {
      expect(await store.deleteTheme(randomUUID())).toBe(false);
    });
  });

  describe('batch operations', () => {
    it('getEntities returns a map keyed by id', async () => {
      const e1 = makeEntity({ name: 'E1' });
      const e2 = makeEntity({ name: 'E2' });
      await store.putEntity(e1);
      await store.putEntity(e2);

      const result = await store.getEntities([e1.id, e2.id]);

      expect(result.size).toBe(2);
      expect(result.get(e1.id)!.name).toBe('E1');
      expect(result.get(e2.id)!.name).toBe('E2');
    });

    it('getEntities returns an empty map for an empty id list', async () => {
      expect(await store.getEntities([])).toEqual(new Map());
    });

    it('getFacts omits missing ids from the result map', async () => {
      const fact = makeFact();
      await store.putFact(fact);

      const result = await store.getFacts([fact.id, randomUUID()]);

      expect(result.size).toBe(1);
      expect(result.has(fact.id)).toBe(true);
    });

    it('getFacts returns an empty map for an empty id list', async () => {
      expect(await store.getFacts([])).toEqual(new Map());
    });

    it('getEpisodes returns a map keyed by id', async () => {
      const ep = makeEpisode();
      await store.putEpisode(ep);

      const result = await store.getEpisodes([ep.id, randomUUID()]);

      expect(result.size).toBe(1);
      expect(result.get(ep.id)!.id).toBe(ep.id);
    });

    it('getEpisodes returns an empty map for an empty id list', async () => {
      expect(await store.getEpisodes([])).toEqual(new Map());
    });

    it('getThemes returns a map keyed by id', async () => {
      const theme = makeTheme();
      await store.putTheme(theme);

      const result = await store.getThemes([theme.id, randomUUID()]);

      expect(result.size).toBe(1);
      expect(result.get(theme.id)!.id).toBe(theme.id);
    });

    it('getThemes returns an empty map for an empty id list', async () => {
      expect(await store.getThemes([])).toEqual(new Map());
    });
  });

  describe('lifecycle', () => {
    it('clear removes all data', async () => {
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

  describe('tenant scoping', () => {
    const TENANT_A = randomUUID();

    beforeAll(async () => {
      const db = await getDb();
      await db
        .insert(tenants)
        .values({ id: TENANT_A, slug: `a-${TENANT_A}`, name: 'Tenant A' })
        .onConflictDoNothing();
    });

    afterAll(async () => {
      const db = await getDb();
      await db.delete(tenants).where(eq(tenants.id, TENANT_A));
    });

    const scoped = new DrizzleMemoryStore({ tenant: { tenant_id: TENANT_A } });

    it('round-trips entities, facts, and relationships under a tenant', async () => {
      const e1 = makeEntity({ name: 'Scoped', entity_type: 'person' });
      const e2 = makeEntity();
      await scoped.putEntity(e1);
      await scoped.putEntity(e2);
      const fact = makeFact({ entity_ids: [e1.id], tags: ['lesson'] });
      await scoped.putFact(fact);
      const rel = makeRelationship(e1.id, e2.id);
      await scoped.putRelationship(rel);

      expect((await scoped.getEntity(e1.id))!.name).toBe('Scoped');
      expect(await scoped.findEntities({ entityType: 'person' })).toHaveLength(1);
      expect(await scoped.findFacts({ tags: ['lesson'] })).toHaveLength(1);
      expect(await scoped.getRelationshipsForEntity(e1.id, { direction: 'both' })).toHaveLength(1);
    });

    it('lists tenant-scoped episodes and themes', async () => {
      await scoped.putEpisode(makeEpisode());
      await scoped.putTheme(makeTheme());

      expect(await scoped.listEpisodes()).toHaveLength(1);
      expect(await scoped.listThemes()).toHaveLength(1);
    });

    it('clear scoped to a tenant empties that tenant graph', async () => {
      await scoped.putEntity(makeEntity());
      await scoped.putFact(makeFact());

      await scoped.clear();

      expect(await scoped.findEntities()).toHaveLength(0);
      expect(await scoped.findFacts()).toHaveLength(0);
    });
  });
});
