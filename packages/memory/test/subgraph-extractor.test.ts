/**
 * Tests for retrieval/subgraph-extractor: BFS expansion from seed entities
 * with hop limits, temporal filtering, cycle safety, and entity-budget closure.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryMemoryStore, extractSubgraph } from '../src/index.js';
import type { Entity, Relationship } from '../src/index.js';
import { makeEntity, makeRelationship } from './helpers.js';

function entity(name: string): Entity {
  return makeEntity({ name, entity_type: 'concept' });
}

function rel(sourceId: string, targetId: string, overrides: Partial<Relationship> = {}): Relationship {
  return makeRelationship({ source_id: sourceId, target_id: targetId, relation_type: 'related_to', ...overrides });
}

describe('extractSubgraph', () => {
  let store: InMemoryMemoryStore;
  let a: Entity, b: Entity, c: Entity, d: Entity;

  beforeEach(async () => {
    store = new InMemoryMemoryStore();
    a = entity('A');
    b = entity('B');
    c = entity('C');
    d = entity('D');
    await store.putEntity(a);
    await store.putEntity(b);
    await store.putEntity(c);
    await store.putEntity(d);
  });

  it('extracts a 1-hop subgraph', async () => {
    await store.putRelationship(rel(a.id, b.id));
    await store.putRelationship(rel(b.id, c.id));

    const result = await extractSubgraph(store, [a.id], { maxHops: 1 });

    expect(result.entities.map((e) => e.name).sort()).toEqual(['A', 'B']);
    expect(result.relationships).toHaveLength(1);
  });

  it('extracts a 2-hop subgraph', async () => {
    await store.putRelationship(rel(a.id, b.id));
    await store.putRelationship(rel(b.id, c.id));
    await store.putRelationship(rel(c.id, d.id));

    const result = await extractSubgraph(store, [a.id], { maxHops: 2 });

    expect(result.entities.map((e) => e.name).sort()).toEqual(['A', 'B', 'C']);
    expect(result.relationships).toHaveLength(2);
  });

  it('handles cycles without looping forever', async () => {
    await store.putRelationship(rel(a.id, b.id));
    await store.putRelationship(rel(b.id, c.id));
    await store.putRelationship(rel(c.id, a.id));

    const result = await extractSubgraph(store, [a.id], { maxHops: 5 });

    expect(result.entities).toHaveLength(3);
    expect(result.relationships).toHaveLength(3);
  });

  it('excludes relationships not valid at the query time', async () => {
    const past = new Date('2023-01-01');
    const future = new Date('2025-01-01');
    await store.putRelationship(rel(a.id, b.id, { valid_from: past, valid_until: new Date('2024-01-01') }));
    await store.putRelationship(rel(a.id, c.id, { valid_from: past }));

    const result = await extractSubgraph(store, [a.id], { maxHops: 1, validAt: future });

    expect(result.entities.map((e) => e.name).sort()).toEqual(['A', 'C']);
    expect(result.relationships).toHaveLength(1);
  });

  it('returns only the seed entity with maxHops=0', async () => {
    await store.putRelationship(rel(a.id, b.id));

    const result = await extractSubgraph(store, [a.id], { maxHops: 0 });

    expect(result.entities).toHaveLength(1);
    expect(result.entities[0].name).toBe('A');
    expect(result.relationships).toHaveLength(0);
  });

  it('stops expanding once maxEntities is reached', async () => {
    await store.putRelationship(rel(a.id, b.id));
    await store.putRelationship(rel(a.id, c.id));
    await store.putRelationship(rel(a.id, d.id));

    const result = await extractSubgraph(store, [a.id], { maxHops: 2, maxEntities: 2 });

    expect(result.entities.length).toBeLessThanOrEqual(2);
  });

  it('keeps a budget-truncated result closed under its own entity set', async () => {
    await store.putRelationship(rel(a.id, b.id));
    await store.putRelationship(rel(a.id, c.id));
    await store.putRelationship(rel(a.id, d.id));

    const result = await extractSubgraph(store, [a.id], { maxHops: 2, maxEntities: 2 });

    const entityIds = new Set(result.entities.map((e) => e.id));
    for (const relationship of result.relationships) {
      expect(entityIds.has(relationship.source_id)).toBe(true);
      expect(entityIds.has(relationship.target_id)).toBe(true);
    }
    expect(result.relationships.length).toBeLessThanOrEqual(1);
  });
});
