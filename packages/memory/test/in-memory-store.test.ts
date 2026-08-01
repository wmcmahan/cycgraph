/**
 * Unit tests for InMemoryMemoryStore — the Map-backed MemoryStore.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryMemoryStore } from '../src/index.js';
import {
  FIXED_DATE,
  makeEntity,
  makeRelationship,
  makeFact,
  makeEpisode,
  makeTheme,
} from './helpers.js';

describe('InMemoryMemoryStore', () => {
  let store: InMemoryMemoryStore;

  beforeEach(() => {
    store = new InMemoryMemoryStore();
  });

  describe('entity operations', () => {
    it('puts and gets an entity', async () => {
      const entity = makeEntity({ name: 'Alice' });

      await store.putEntity(entity);

      expect(await store.getEntity(entity.id)).toEqual(entity);
    });

    it('returns null for a missing entity', async () => {
      expect(await store.getEntity('nonexistent')).toBeNull();
    });

    it('upserts on a duplicate id', async () => {
      const entity = makeEntity({ name: 'Alice' });
      await store.putEntity(entity);

      await store.putEntity({ ...entity, name: 'Bob' });

      const retrieved = await store.getEntity(entity.id);
      expect(retrieved!.name).toBe('Bob');
    });

    it('findEntities filters by entity type', async () => {
      await store.putEntity(makeEntity({ entity_type: 'person' }));
      await store.putEntity(makeEntity({ entity_type: 'org' }));

      const people = await store.findEntities({ entityType: 'person' });

      expect(people).toHaveLength(1);
      expect(people[0].entity_type).toBe('person');
    });

    it('findEntities excludes invalidated entities by default', async () => {
      await store.putEntity(makeEntity({ invalidated_at: FIXED_DATE }));
      await store.putEntity(makeEntity());

      expect(await store.findEntities()).toHaveLength(1);
      expect(await store.findEntities({ includeInvalidated: true })).toHaveLength(2);
    });

    it('findEntities paginates with offset and limit', async () => {
      await store.putEntity(makeEntity({ name: 'A' }));
      await store.putEntity(makeEntity({ name: 'B' }));
      await store.putEntity(makeEntity({ name: 'C' }));

      const page = await store.findEntities({ offset: 1, limit: 1 });

      expect(page).toHaveLength(1);
      expect(page[0].name).toBe('B');
    });

    it('deleteEntity removes the entity and its relationships', async () => {
      const a = makeEntity();
      const b = makeEntity();
      await store.putEntity(a);
      await store.putEntity(b);
      await store.putRelationship(makeRelationship({ source_id: a.id, target_id: b.id }));

      await store.deleteEntity(a.id);

      expect(await store.getEntity(a.id)).toBeNull();
      expect(await store.getRelationshipsForEntity(b.id)).toHaveLength(0);
    });

    it('deleteEntity returns false when the entity is absent', async () => {
      expect(await store.deleteEntity('nonexistent')).toBe(false);
    });

    it('deleteEntity removes an entity that has no relationships', async () => {
      const entity = makeEntity();
      await store.putEntity(entity);

      expect(await store.deleteEntity(entity.id)).toBe(true);
      expect(await store.getEntity(entity.id)).toBeNull();
    });

    it('deleteEntity deindexes the counter-party so no stale edge survives', async () => {
      const a = makeEntity();
      const b = makeEntity();
      const c = makeEntity();
      await store.putEntity(a);
      await store.putEntity(b);
      await store.putEntity(c);
      await store.putRelationship(makeRelationship({ source_id: a.id, target_id: b.id }));
      await store.putRelationship(makeRelationship({ source_id: a.id, target_id: c.id }));

      await store.deleteEntity(b.id);

      const aRels = await store.getRelationshipsForEntity(a.id);
      expect(aRels).toHaveLength(1);
      expect(aRels[0].target_id).toBe(c.id);
      const cRels = await store.getRelationshipsForEntity(c.id);
      expect(cRels).toHaveLength(1);
      expect(cRels[0].source_id).toBe(a.id);
    });

    it('deep-clones entities on read so caller mutations do not leak back', async () => {
      const entity = makeEntity({ attributes: { key: 'value' } });
      await store.putEntity(entity);

      const retrieved = await store.getEntity(entity.id);
      (retrieved!.attributes as Record<string, unknown>).key = 'mutated';

      const again = await store.getEntity(entity.id);
      expect((again!.attributes as Record<string, unknown>).key).toBe('value');
    });
  });

  describe('relationship operations', () => {
    it('puts and gets a relationship', async () => {
      const rel = makeRelationship();

      await store.putRelationship(rel);

      expect(await store.getRelationship(rel.id)).toEqual(rel);
    });

    it('returns null for a missing relationship', async () => {
      expect(await store.getRelationship('nonexistent')).toBeNull();
    });

    it('re-putting a relationship with new endpoints deindexes the old ones', async () => {
      const a = crypto.randomUUID();
      const b = crypto.randomUUID();
      const c = crypto.randomUUID();
      const rel = makeRelationship({ source_id: a, target_id: b });
      await store.putRelationship(rel);

      await store.putRelationship({ ...rel, target_id: c });

      expect(await store.getRelationshipsForEntity(b, { direction: 'both' })).toHaveLength(0);
      expect(await store.getRelationshipsForEntity(c, { direction: 'both' })).toHaveLength(1);
      expect(await store.getRelationshipsForEntity(a, { direction: 'both' })).toHaveLength(1);
    });

    it('getRelationshipsForEntity returns empty for an unknown entity', async () => {
      expect(await store.getRelationshipsForEntity('nonexistent')).toHaveLength(0);
    });

    it('getRelationshipsForEntity filters by direction', async () => {
      const a = crypto.randomUUID();
      const b = crypto.randomUUID();
      const c = crypto.randomUUID();
      await store.putRelationship(makeRelationship({ source_id: a, target_id: b }));
      await store.putRelationship(makeRelationship({ source_id: c, target_id: a }));

      const outgoing = await store.getRelationshipsForEntity(a, { direction: 'outgoing' });
      expect(outgoing).toHaveLength(1);
      expect(outgoing[0].target_id).toBe(b);

      const incoming = await store.getRelationshipsForEntity(a, { direction: 'incoming' });
      expect(incoming).toHaveLength(1);
      expect(incoming[0].source_id).toBe(c);

      const both = await store.getRelationshipsForEntity(a, { direction: 'both' });
      expect(both).toHaveLength(2);
    });

    it('getRelationshipsForEntity filters by relation type', async () => {
      const a = crypto.randomUUID();
      const b = crypto.randomUUID();
      await store.putRelationship(makeRelationship({ source_id: a, target_id: b, relation_type: 'works_at' }));
      await store.putRelationship(makeRelationship({ source_id: a, target_id: b, relation_type: 'knows' }));

      const filtered = await store.getRelationshipsForEntity(a, { relationType: 'works_at' });

      expect(filtered).toHaveLength(1);
      expect(filtered[0].relation_type).toBe('works_at');
    });

    it('getRelationshipsForEntity excludes invalidated relationships by default', async () => {
      const a = crypto.randomUUID();
      const b = crypto.randomUUID();
      await store.putRelationship(makeRelationship({ source_id: a, target_id: b, invalidated_by: crypto.randomUUID() }));

      expect(await store.getRelationshipsForEntity(a)).toHaveLength(0);
      expect(await store.getRelationshipsForEntity(a, { includeInvalidated: true })).toHaveLength(1);
    });

    it('deleteRelationship removes the edge from both endpoints', async () => {
      const a = crypto.randomUUID();
      const b = crypto.randomUUID();
      const rel = makeRelationship({ source_id: a, target_id: b });
      await store.putRelationship(rel);

      expect(await store.deleteRelationship(rel.id)).toBe(true);

      expect(await store.getRelationship(rel.id)).toBeNull();
      expect(await store.getRelationshipsForEntity(a)).toHaveLength(0);
      expect(await store.getRelationshipsForEntity(b)).toHaveLength(0);
    });

    it('deleteRelationship returns false when the edge is absent', async () => {
      expect(await store.deleteRelationship('nonexistent')).toBe(false);
    });

    it('deleteRelationship deindexes a self-loop edge cleanly', async () => {
      const self = crypto.randomUUID();
      const rel = makeRelationship({ source_id: self, target_id: self });
      await store.putRelationship(rel);

      expect(await store.deleteRelationship(rel.id)).toBe(true);
      expect(await store.getRelationshipsForEntity(self)).toHaveLength(0);
    });
  });

  describe('episode operations', () => {
    it('puts and gets an episode', async () => {
      const episode = makeEpisode({ topic: 'Planning' });

      await store.putEpisode(episode);

      expect(await store.getEpisode(episode.id)).toEqual(episode);
    });

    it('returns null for a missing episode', async () => {
      expect(await store.getEpisode('nonexistent')).toBeNull();
    });

    it('listEpisodes sorts by started_at descending', async () => {
      const older = makeEpisode({ topic: 'First', started_at: new Date('2024-01-01'), ended_at: new Date('2024-01-01') });
      const newer = makeEpisode({ topic: 'Second', started_at: new Date('2024-06-01'), ended_at: new Date('2024-06-01') });
      await store.putEpisode(older);
      await store.putEpisode(newer);

      const list = await store.listEpisodes();

      expect(list.map((e) => e.topic)).toEqual(['Second', 'First']);
    });

    it('deleteEpisode removes the episode', async () => {
      const episode = makeEpisode();
      await store.putEpisode(episode);

      expect(await store.deleteEpisode(episode.id)).toBe(true);
      expect(await store.getEpisode(episode.id)).toBeNull();
    });
  });

  describe('fact operations', () => {
    it('puts and gets a fact', async () => {
      const fact = makeFact({ content: 'Alice ships code' });

      await store.putFact(fact);

      expect(await store.getFact(fact.id)).toEqual(fact);
    });

    it('returns null for a missing fact', async () => {
      expect(await store.getFact('nonexistent')).toBeNull();
    });

    it('findFacts filters by theme id', async () => {
      const themeId = crypto.randomUUID();
      await store.putFact(makeFact({ theme_id: themeId }));
      await store.putFact(makeFact());

      const filtered = await store.findFacts({ themeId });

      expect(filtered).toHaveLength(1);
      expect(filtered[0].theme_id).toBe(themeId);
    });

    it('findFacts filters by entity id', async () => {
      const entityId = crypto.randomUUID();
      await store.putFact(makeFact({ entity_ids: [entityId] }));
      await store.putFact(makeFact());

      const filtered = await store.findFacts({ entityId });

      expect(filtered).toHaveLength(1);
      expect(filtered[0].entity_ids).toContain(entityId);
    });

    it('findFacts filters by tags with OR semantics', async () => {
      await store.putFact(makeFact({ content: 'lesson', tags: ['lesson', 'graph:x'] }));
      await store.putFact(makeFact({ content: 'other', tags: ['graph:x'] }));
      await store.putFact(makeFact({ content: 'untagged', tags: [] }));

      const byLesson = await store.findFacts({ tags: ['lesson'] });
      expect(byLesson).toHaveLength(1);
      expect(byLesson[0].content).toBe('lesson');

      const byGraph = await store.findFacts({ tags: ['graph:x'] });
      expect(byGraph.map((f) => f.content).sort()).toEqual(['lesson', 'other']);
    });

    it('findFacts treats empty or omitted tags as a no-op', async () => {
      await store.putFact(makeFact({ tags: ['lesson'] }));
      await store.putFact(makeFact({ tags: [] }));

      expect(await store.findFacts({ tags: [] })).toHaveLength(2);
      expect(await store.findFacts({})).toHaveLength(2);
    });

    it('findFacts drops facts carrying any excludeTags', async () => {
      await store.putFact(makeFact({ content: 'keep', tags: ['graph:x'] }));
      await store.putFact(makeFact({ content: 'drop', tags: ['graph:x', 'candidate'] }));

      const filtered = await store.findFacts({ excludeTags: ['candidate'] });

      expect(filtered).toHaveLength(1);
      expect(filtered[0].content).toBe('keep');
    });

    it('findFacts keeps facts with no tags when excludeTags is set', async () => {
      const untagged = { ...makeFact({ content: 'untagged' }), tags: undefined as unknown as string[] };
      await store.putFact(untagged);

      const filtered = await store.findFacts({ excludeTags: ['candidate'] });

      expect(filtered).toHaveLength(1);
      expect(filtered[0].content).toBe('untagged');
    });

    it('findFacts excludes invalidated facts by default', async () => {
      await store.putFact(makeFact({ invalidated_by: 'eval-gate:evicted' }));
      await store.putFact(makeFact());

      expect(await store.findFacts()).toHaveLength(1);
      expect(await store.findFacts({ includeInvalidated: true })).toHaveLength(2);
    });

    it('deleteFact removes the fact', async () => {
      const fact = makeFact();
      await store.putFact(fact);

      expect(await store.deleteFact(fact.id)).toBe(true);
      expect(await store.getFact(fact.id)).toBeNull();
    });
  });

  describe('theme operations', () => {
    it('puts, gets, lists and deletes a theme', async () => {
      const theme = makeTheme();
      await store.putTheme(theme);

      expect(await store.getTheme(theme.id)).toEqual(theme);
      expect(await store.listThemes()).toHaveLength(1);
      expect(await store.deleteTheme(theme.id)).toBe(true);
      expect(await store.listThemes()).toHaveLength(0);
    });

    it('returns null for a missing theme', async () => {
      expect(await store.getTheme('nonexistent')).toBeNull();
    });
  });

  describe('touchFacts', () => {
    it('increments access_count and stamps last_accessed_at', async () => {
      const fact = makeFact({ access_count: 0 });
      await store.putFact(fact);
      const at = new Date('2026-01-01');

      await store.touchFacts([fact.id], at);
      await store.touchFacts([fact.id], at);

      const touched = await store.getFact(fact.id);
      expect(touched?.access_count).toBe(2);
      expect(touched?.last_accessed_at).toEqual(at);
    });

    it('ignores ids that do not exist', async () => {
      const fact = makeFact({ access_count: 0 });
      await store.putFact(fact);
      const at = new Date('2026-01-01');

      await store.touchFacts([fact.id, crypto.randomUUID()], at);

      const touched = await store.getFact(fact.id);
      expect(touched?.access_count).toBe(1);
    });

    it('defaults the timestamp to now when omitted', async () => {
      const fact = makeFact({ access_count: 0 });
      await store.putFact(fact);

      await store.touchFacts([fact.id]);

      const touched = await store.getFact(fact.id);
      expect(touched?.access_count).toBe(1);
      expect(touched?.last_accessed_at).toBeInstanceOf(Date);
    });
  });

  describe('clear', () => {
    it('removes all stored records', async () => {
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
