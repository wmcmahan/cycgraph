/**
 * Tests for retrieval/hierarchical-retriever: the embedding, entity, and
 * tag-only retrieval paths of retrieveMemory, plus quarantine exclusion.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryMemoryStore, InMemoryMemoryIndex, retrieveMemory } from '../src/index.js';
import type { SemanticFact } from '../src/index.js';
import { FIXED_DATE, makeEntity, makeFact, makeTheme, makeEpisode, makeRelationship } from './helpers.js';

const NOW = FIXED_DATE;
const DEFAULTS = { maxHops: 2, limit: 20, minSimilarity: 0.5, includeInvalidated: false };

describe('retrieveMemory', () => {
  let store: InMemoryMemoryStore;
  let index: InMemoryMemoryIndex;

  beforeEach(() => {
    store = new InMemoryMemoryStore();
    index = new InMemoryMemoryIndex();
  });

  it('returns an empty result when the query has no embedding, entities, or tags', async () => {
    const result = await retrieveMemory(store, index, { ...DEFAULTS });

    expect(result.themes).toEqual([]);
    expect(result.facts).toEqual([]);
    expect(result.episodes).toEqual([]);
    expect(result.entities).toEqual([]);
    expect(result.relationships).toEqual([]);
  });

  describe('embedding-based retrieval', () => {
    beforeEach(async () => {
      const entity = makeEntity({ name: 'Alice' });
      const episode = makeEpisode({ topic: 'Meeting' });
      const fact = makeFact({
        content: 'Alice is a person',
        source_episode_ids: [episode.id],
        entity_ids: [entity.id],
        embedding: [1, 0, 0],
      });
      const theme = makeTheme({ label: 'People', fact_ids: [fact.id], embedding: [1, 0, 0] });

      await store.putEntity(entity);
      await store.putEpisode(episode);
      await store.putFact(fact);
      await store.putTheme(theme);
      await index.rebuild(store);
    });

    it('scores the facts it ranked', async () => {
      const result = await retrieveMemory(store, index, { ...DEFAULTS, embedding: [1, 0, 0] });

      expect(result.scores?.[result.facts[0].id]).toBeCloseTo(1, 5);
    });

    it('scores only facts it returned', async () => {
      const result = await retrieveMemory(store, index, { ...DEFAULTS, embedding: [1, 0, 0] });

      expect(Object.keys(result.scores ?? {})).toEqual(result.facts.map((f) => f.id));
    });

    it('retrieves themes, facts, episodes, and entities by embedding', async () => {
      const result = await retrieveMemory(store, index, { ...DEFAULTS, embedding: [1, 0, 0] });

      expect(result.themes).toHaveLength(1);
      expect(result.themes[0].label).toBe('People');
      expect(result.facts).toHaveLength(1);
      expect(result.episodes).toHaveLength(1);
      expect(result.entities).toHaveLength(1);
      expect(result.entities[0].name).toBe('Alice');
    });

    it('returns nothing when no stored embedding clears minSimilarity', async () => {
      const result = await retrieveMemory(store, index, {
        ...DEFAULTS,
        embedding: [0, 1, 0],
        minSimilarity: 0.9,
      });

      expect(result.themes).toHaveLength(0);
      expect(result.facts).toHaveLength(0);
    });
  });

  describe('embedding-based relationship closure', () => {
    it('returns only relationships whose endpoints are both in the fact entity set', async () => {
      const alice = makeEntity({ name: 'Alice' });
      const bob = makeEntity({ name: 'Bob' });
      const carol = makeEntity({ name: 'Carol' });
      const insideEdge = makeRelationship({ source_id: alice.id, target_id: bob.id, relation_type: 'knows' });
      const danglingEdge = makeRelationship({ source_id: alice.id, target_id: carol.id, relation_type: 'knows' });
      const fact = makeFact({ content: 'Alice knows Bob', entity_ids: [alice.id, bob.id], embedding: [1, 0, 0] });
      const theme = makeTheme({ label: 'People', fact_ids: [fact.id], embedding: [1, 0, 0] });

      await store.putEntity(alice);
      await store.putEntity(bob);
      await store.putEntity(carol);
      await store.putRelationship(insideEdge);
      await store.putRelationship(danglingEdge);
      await store.putFact(fact);
      await store.putTheme(theme);
      await index.rebuild(store);

      const result = await retrieveMemory(store, index, { ...DEFAULTS, embedding: [1, 0, 0] });

      expect(result.entities.map((e) => e.name).sort()).toEqual(['Alice', 'Bob']);
      expect(result.relationships.map((r) => r.id)).toEqual([insideEdge.id]);
    });
  });

  describe('entity-based retrieval', () => {
    it('retrieves the subgraph plus facts referencing the seed entities', async () => {
      const a = makeEntity({ name: 'A', entity_type: 'concept' });
      const b = makeEntity({ name: 'B', entity_type: 'concept' });
      const rel = makeRelationship({ source_id: a.id, target_id: b.id, relation_type: 'knows' });
      const fact = makeFact({ content: 'A knows B', entity_ids: [a.id, b.id] });

      await store.putEntity(a);
      await store.putEntity(b);
      await store.putRelationship(rel);
      await store.putFact(fact);

      const result = await retrieveMemory(store, index, { ...DEFAULTS, entityIds: [a.id], maxHops: 1 });

      expect(result.entities).toHaveLength(2);
      expect(result.relationships).toHaveLength(1);
      expect(result.facts).toHaveLength(1);
    });

    it('deduplicates a fact shared across multiple entities', async () => {
      const x = makeEntity({ name: 'X', entity_type: 'concept' });
      const y = makeEntity({ name: 'Y', entity_type: 'concept' });
      const rel = makeRelationship({ source_id: x.id, target_id: y.id, relation_type: 'related' });
      const shared = makeFact({ content: 'X and Y are related', entity_ids: [x.id, y.id] });

      await store.putEntity(x);
      await store.putEntity(y);
      await store.putRelationship(rel);
      await store.putFact(shared);

      const result = await retrieveMemory(store, index, { ...DEFAULTS, entityIds: [x.id], maxHops: 1, limit: 50 });

      expect(result.facts).toHaveLength(1);
      expect(result.facts[0].id).toBe(shared.id);
    });

    it('attaches themes and episodes referenced by entity-path facts', async () => {
      const entity = makeEntity({ name: 'A', entity_type: 'concept' });
      const theme = makeTheme({ label: 'Concepts' });
      const episode = makeEpisode({ topic: 'Source' });
      const fact = makeFact({
        content: 'A is documented',
        entity_ids: [entity.id],
        theme_id: theme.id,
        source_episode_ids: [episode.id],
      });

      await store.putEntity(entity);
      await store.putTheme(theme);
      await store.putEpisode(episode);
      await store.putFact(fact);

      const result = await retrieveMemory(store, index, { ...DEFAULTS, entityIds: [entity.id], maxHops: 1 });

      expect(result.themes.map((t) => t.id)).toEqual([theme.id]);
      expect(result.episodes.map((e) => e.id)).toEqual([episode.id]);
    });
  });

  describe('tag-only retrieval', () => {
    it('reports no scores, because the tag path selects rather than ranks', async () => {
      const fact = makeFact({ content: 'tagged', tags: ['lesson'] });
      await store.putFact(fact);
      await index.rebuild(store);

      const result = await retrieveMemory(store, index, { ...DEFAULTS, tags: ['lesson'] });

      expect({ facts: result.facts.length, scores: result.scores }).toEqual({ facts: 1, scores: undefined });
    });

    const seedFact = (overrides: Partial<SemanticFact> = {}): Promise<void> =>
      store.putFact(makeFact({ content: 'Some lesson worth keeping.', valid_from: NOW, ...overrides }));

    it('returns only facts whose tags intersect the query tags', async () => {
      const lessonA = makeFact({ content: 'A', tags: ['lesson', 'graph:research-v1'] });
      const lessonB = makeFact({ content: 'B', tags: ['lesson', 'graph:research-v1'] });
      await store.putFact(lessonA);
      await store.putFact(lessonB);
      await seedFact({ content: 'untagged' });
      await seedFact({ content: 'wrong tag', tags: ['warning'] });

      const result = await retrieveMemory(store, index, { ...DEFAULTS, tags: ['lesson'] });

      expect(new Set(result.facts.map((f) => f.id))).toEqual(new Set([lessonA.id, lessonB.id]));
      expect(result.entities).toEqual([]);
      expect(result.relationships).toEqual([]);
    });

    it('matches on any query tag rather than requiring all of them', async () => {
      const lessonA = makeFact({ content: 'A', tags: ['lesson'] });
      const lessonB = makeFact({ content: 'B', tags: ['warning'] });
      await store.putFact(lessonA);
      await store.putFact(lessonB);

      const result = await retrieveMemory(store, index, { ...DEFAULTS, tags: ['lesson', 'warning'] });

      expect(new Set(result.facts.map((f) => f.id))).toEqual(new Set([lessonA.id, lessonB.id]));
    });

    it('respects the limit', async () => {
      for (let i = 0; i < 5; i++) {
        await seedFact({ content: `lesson ${i}`, tags: ['lesson'] });
      }

      const result = await retrieveMemory(store, index, { ...DEFAULTS, tags: ['lesson'], limit: 3 });

      expect(result.facts).toHaveLength(3);
    });

    it('pages through the store until the limit is met', async () => {
      for (let i = 0; i < 100; i++) {
        await seedFact({ content: `lesson ${i}`, tags: ['lesson'] });
      }

      const result = await retrieveMemory(store, index, { ...DEFAULTS, tags: ['lesson'], limit: 20 });

      expect(result.facts).toHaveLength(20);
    });

    it('excludes invalidated facts by validity window', async () => {
      await seedFact({ content: 'still valid', tags: ['lesson'] });
      await seedFact({ content: 'invalidated', tags: ['lesson'], valid_until: new Date(NOW.getTime() - 1000) });

      const result = await retrieveMemory(store, index, { ...DEFAULTS, tags: ['lesson'], validAt: NOW });

      expect(result.facts).toHaveLength(1);
      expect(result.facts[0].content).toBe('still valid');
    });

    it('attaches themes present on matching facts', async () => {
      const theme = makeTheme({ label: 'Research Lessons', description: 'distilled methodology guidance' });
      await store.putTheme(theme);
      await seedFact({ content: 'Cite primary sources.', tags: ['lesson'], theme_id: theme.id });

      const result = await retrieveMemory(store, index, { ...DEFAULTS, tags: ['lesson'] });

      expect(result.themes.map((t) => t.id)).toEqual([theme.id]);
    });

    it('attaches episodes referenced by matching facts', async () => {
      const episode = makeEpisode({ topic: 'Source' });
      await store.putEpisode(episode);
      await seedFact({ content: 'Learned from a source.', tags: ['lesson'], source_episode_ids: [episode.id] });

      const result = await retrieveMemory(store, index, { ...DEFAULTS, tags: ['lesson'] });

      expect(result.episodes.map((e) => e.id)).toEqual([episode.id]);
    });

    it('returns an empty result when no fact carries a query tag', async () => {
      await seedFact({ content: 'A', tags: ['lesson'] });

      const result = await retrieveMemory(store, index, { ...DEFAULTS, tags: ['nonexistent'] });

      expect(result.facts).toEqual([]);
    });
  });

  describe('quarantine exclusion', () => {
    const putFact = (overrides: Partial<SemanticFact>): Promise<void> =>
      store.putFact(makeFact({ content: 'fact', valid_from: NOW, ...overrides }));

    it('excludes quarantined facts from tag-only retrieval', async () => {
      const clean = makeFact({ content: 'clean', tags: ['lesson'] });
      await store.putFact(clean);
      await putFact({ content: 'poisoned', tags: ['lesson', 'quarantined'] });

      const result = await retrieveMemory(store, index, { ...DEFAULTS, tags: ['lesson'] });

      expect(result.facts.map((f) => f.id)).toEqual([clean.id]);
    });

    it('excludes quarantined facts from embedding-based retrieval', async () => {
      const clean = makeFact({ content: 'clean', embedding: [1, 0, 0] });
      await store.putFact(clean);
      await putFact({ content: 'poisoned', embedding: [1, 0, 0], tags: ['quarantined'] });
      await index.rebuild(store);

      const result = await retrieveMemory(store, index, { ...DEFAULTS, embedding: [1, 0, 0], tags: [] });

      expect(result.facts.map((f) => f.id)).toEqual([clean.id]);
    });

    it('excludes quarantined facts from entity-based retrieval', async () => {
      const entity = makeEntity({ name: 'Alice' });
      await store.putEntity(entity);
      const clean = makeFact({ content: 'clean', entity_ids: [entity.id] });
      await store.putFact(clean);
      await putFact({ content: 'poisoned', entity_ids: [entity.id], tags: ['quarantined'] });

      const result = await retrieveMemory(store, index, { ...DEFAULTS, entityIds: [entity.id], tags: [] });

      expect(result.facts.map((f) => f.id)).toEqual([clean.id]);
    });

    it('returns quarantined facts when a tag-only query explicitly audits the tag', async () => {
      await putFact({ content: 'clean', tags: ['lesson'] });
      const poisoned = makeFact({ content: 'poisoned', tags: ['lesson', 'quarantined'] });
      await store.putFact(poisoned);

      const result = await retrieveMemory(store, index, { ...DEFAULTS, tags: ['quarantined'] });

      expect(result.facts.map((f) => f.id)).toEqual([poisoned.id]);
    });

    it('returns quarantined facts from entity-based retrieval when auditing the tag', async () => {
      const entity = makeEntity({ name: 'Alice' });
      await store.putEntity(entity);
      const poisoned = makeFact({ content: 'poisoned', entity_ids: [entity.id], tags: ['quarantined'] });
      await store.putFact(poisoned);

      const result = await retrieveMemory(store, index, {
        ...DEFAULTS,
        entityIds: [entity.id],
        tags: ['quarantined'],
      });

      expect(result.facts.map((f) => f.id)).toEqual([poisoned.id]);
    });
  });
});
