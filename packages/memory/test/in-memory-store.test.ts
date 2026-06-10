import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryMemoryStore } from '../src/index.js';
import type { Entity, Relationship, Episode, SemanticFact, Theme, Provenance } from '../src/index.js';

const now = new Date();
const prov: Provenance = { source: 'system', created_at: now };

function makeEntity(overrides: Partial<Entity> = {}): Entity {
  return {
    id: crypto.randomUUID(),
    name: 'Test Entity',
    entity_type: 'concept',
    attributes: {},
    provenance: prov,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function makeRelationship(sourceId: string, targetId: string, overrides: Partial<Relationship> = {}): Relationship {
  return {
    id: crypto.randomUUID(),
    source_id: sourceId,
    target_id: targetId,
    relation_type: 'related_to',
    weight: 1,
    attributes: {},
    valid_from: now,
    provenance: prov,
    ...overrides,
  };
}

function makeFact(overrides: Partial<SemanticFact> = {}): SemanticFact {
  return {
    id: crypto.randomUUID(),
    content: 'Test fact',
    source_episode_ids: [],
    entity_ids: [],
    provenance: prov,
    valid_from: now,
    ...overrides,
  };
}

function makeTheme(overrides: Partial<Theme> = {}): Theme {
  return {
    id: crypto.randomUUID(),
    label: 'Test Theme',
    description: '',
    fact_ids: [],
    provenance: prov,
    ...overrides,
  };
}

describe('InMemoryMemoryStore', () => {
  let store: InMemoryMemoryStore;

  beforeEach(async () => {
    store = new InMemoryMemoryStore();
  });

  describe('Entity CRUD', () => {
    it('put and get entity', async () => {
      const entity = makeEntity({ name: 'Alice' });
      await store.putEntity(entity);
      const retrieved = await store.getEntity(entity.id);
      expect(retrieved).toEqual(entity);
    });

    it('returns null for missing entity', async () => {
      expect(await store.getEntity('nonexistent')).toBeNull();
    });

    it('upserts on duplicate id', async () => {
      const entity = makeEntity({ name: 'Alice' });
      await store.putEntity(entity);
      await store.putEntity({ ...entity, name: 'Bob' });
      const retrieved = await store.getEntity(entity.id);
      expect(retrieved!.name).toBe('Bob');
    });

    it('findEntities filters by type', async () => {
      await store.putEntity(makeEntity({ entity_type: 'person' }));
      await store.putEntity(makeEntity({ entity_type: 'org' }));
      const people = await store.findEntities({ entity_type: 'person' });
      expect(people).toHaveLength(1);
      expect(people[0].entity_type).toBe('person');
    });

    it('findEntities excludes invalidated by default', async () => {
      await store.putEntity(makeEntity({ invalidated_at: now }));
      await store.putEntity(makeEntity());
      expect(await store.findEntities()).toHaveLength(1);
      expect(await store.findEntities({ include_invalidated: true })).toHaveLength(2);
    });

    it('deleteEntity removes entity and its relationships', async () => {
      const a = makeEntity();
      const b = makeEntity();
      await store.putEntity(a);
      await store.putEntity(b);
      await store.putRelationship(makeRelationship(a.id, b.id));

      await store.deleteEntity(a.id);
      expect(await store.getEntity(a.id)).toBeNull();
      expect(await store.getRelationshipsForEntity(b.id)).toHaveLength(0);
    });

    it('deleteEntity cleans up counter-party relationship index (no stale refs)', async () => {
      const a = makeEntity();
      const b = makeEntity();
      const c = makeEntity();
      await store.putEntity(a);
      await store.putEntity(b);
      await store.putEntity(c);

      // A -> B and A -> C
      await store.putRelationship(makeRelationship(a.id, b.id));
      await store.putRelationship(makeRelationship(a.id, c.id));

      // Delete target entity B — A's index should no longer reference the A->B relationship
      await store.deleteEntity(b.id);

      const aRels = await store.getRelationshipsForEntity(a.id);
      expect(aRels).toHaveLength(1);
      expect(aRels[0].target_id).toBe(c.id);

      // C's index should be unaffected
      const cRels = await store.getRelationshipsForEntity(c.id);
      expect(cRels).toHaveLength(1);
      expect(cRels[0].source_id).toBe(a.id);
    });

    it('deep-clones on read (mutation safety)', async () => {
      const entity = makeEntity({ attributes: { key: 'value' } });
      await store.putEntity(entity);
      const retrieved = await store.getEntity(entity.id);
      (retrieved!.attributes as Record<string, unknown>).key = 'mutated';
      const again = await store.getEntity(entity.id);
      expect((again!.attributes as Record<string, unknown>).key).toBe('value');
    });
  });

  describe('Relationship CRUD', () => {
    it('put and get relationship', async () => {
      const rel = makeRelationship(crypto.randomUUID(), crypto.randomUUID());
      await store.putRelationship(rel);
      expect(await store.getRelationship(rel.id)).toEqual(rel);
    });

    it('getRelationshipsForEntity filters by direction', async () => {
      const a = crypto.randomUUID();
      const b = crypto.randomUUID();
      const c = crypto.randomUUID();
      await store.putRelationship(makeRelationship(a, b));
      await store.putRelationship(makeRelationship(c, a));

      const outgoing = await store.getRelationshipsForEntity(a, { direction: 'outgoing' });
      expect(outgoing).toHaveLength(1);
      expect(outgoing[0].target_id).toBe(b);

      const incoming = await store.getRelationshipsForEntity(a, { direction: 'incoming' });
      expect(incoming).toHaveLength(1);
      expect(incoming[0].source_id).toBe(c);

      const both = await store.getRelationshipsForEntity(a, { direction: 'both' });
      expect(both).toHaveLength(2);
    });

    it('getRelationshipsForEntity filters by relation_type', async () => {
      const a = crypto.randomUUID();
      const b = crypto.randomUUID();
      await store.putRelationship(makeRelationship(a, b, { relation_type: 'works_at' }));
      await store.putRelationship(makeRelationship(a, b, { relation_type: 'knows' }));

      const filtered = await store.getRelationshipsForEntity(a, { relation_type: 'works_at' });
      expect(filtered).toHaveLength(1);
    });
  });

  describe('Episode CRUD', () => {
    it('put and list episodes sorted by started_at desc', async () => {
      const older: Episode = {
        id: crypto.randomUUID(),
        topic: 'First',
        messages: [],
        started_at: new Date('2024-01-01'),
        ended_at: new Date('2024-01-01'),
        fact_ids: [],
        provenance: prov,
      };
      const newer: Episode = {
        id: crypto.randomUUID(),
        topic: 'Second',
        messages: [],
        started_at: new Date('2024-06-01'),
        ended_at: new Date('2024-06-01'),
        fact_ids: [],
        provenance: prov,
      };
      await store.putEpisode(older);
      await store.putEpisode(newer);
      const list = await store.listEpisodes();
      expect(list[0].topic).toBe('Second');
      expect(list[1].topic).toBe('First');
    });
  });

  describe('Fact CRUD', () => {
    it('findFacts filters by theme_id', async () => {
      const themeId = crypto.randomUUID();
      await store.putFact(makeFact({ theme_id: themeId }));
      await store.putFact(makeFact());
      const filtered = await store.findFacts({ theme_id: themeId });
      expect(filtered).toHaveLength(1);
    });

    it('findFacts filters by tags (OR semantics)', async () => {
      await store.putFact(makeFact({ content: 'lesson', tags: ['lesson', 'graph:x'] }));
      await store.putFact(makeFact({ content: 'other', tags: ['graph:x'] }));
      await store.putFact(makeFact({ content: 'untagged', tags: [] }));

      const byLesson = await store.findFacts({ tags: ['lesson'] });
      expect(byLesson).toHaveLength(1);
      expect(byLesson[0].content).toBe('lesson');

      const byGraph = await store.findFacts({ tags: ['graph:x'] });
      expect(byGraph.map((f) => f.content).sort()).toEqual(['lesson', 'other']);

      // Empty/omitted tags is a no-op (returns all).
      expect(await store.findFacts({ tags: [] })).toHaveLength(3);
      expect(await store.findFacts({})).toHaveLength(3);
    });

    it('findFacts filters by entity_id', async () => {
      const entityId = crypto.randomUUID();
      await store.putFact(makeFact({ entity_ids: [entityId] }));
      await store.putFact(makeFact());
      const filtered = await store.findFacts({ entity_id: entityId });
      expect(filtered).toHaveLength(1);
    });
  });

  describe('Theme CRUD', () => {
    it('put, get, list, delete', async () => {
      const theme = makeTheme();
      await store.putTheme(theme);
      expect(await store.getTheme(theme.id)).toEqual(theme);
      expect(await store.listThemes()).toHaveLength(1);
      expect(await store.deleteTheme(theme.id)).toBe(true);
      expect(await store.listThemes()).toHaveLength(0);
    });
  });

  describe('clear', () => {
    it('removes all data', async () => {
      await store.putEntity(makeEntity());
      await store.putFact(makeFact());
      await store.putTheme(makeTheme());
      await store.clear();
      expect(await store.findEntities()).toHaveLength(0);
      expect(await store.findFacts()).toHaveLength(0);
      expect(await store.listThemes()).toHaveLength(0);
    });
  });
});
