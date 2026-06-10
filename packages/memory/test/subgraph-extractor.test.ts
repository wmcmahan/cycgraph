import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryMemoryStore, extractSubgraph } from '../src/index.js';
import type { Entity, Relationship, Provenance } from '../src/index.js';

const now = new Date();
const prov: Provenance = { source: 'system', created_at: now };

function makeEntity(name: string): Entity {
  return {
    id: crypto.randomUUID(),
    name,
    entity_type: 'concept',
    attributes: {},
    provenance: prov,
    created_at: now,
    updated_at: now,
  };
}

function makeRel(sourceId: string, targetId: string, overrides: Partial<Relationship> = {}): Relationship {
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

describe('extractSubgraph', () => {
  let store: InMemoryMemoryStore;
  let a: Entity, b: Entity, c: Entity, d: Entity;

  beforeEach(async () => {
    store = new InMemoryMemoryStore();
    a = makeEntity('A');
    b = makeEntity('B');
    c = makeEntity('C');
    d = makeEntity('D');
    await store.putEntity(a);
    await store.putEntity(b);
    await store.putEntity(c);
    await store.putEntity(d);
  });

  it('extracts 1-hop subgraph', async () => {
    await store.putRelationship(makeRel(a.id, b.id));
    await store.putRelationship(makeRel(b.id, c.id));

    const result = await extractSubgraph(store, [a.id], { max_hops: 1 });
    const names = result.entities.map((e) => e.name).sort();
    expect(names).toEqual(['A', 'B']);
    expect(result.relationships).toHaveLength(1);
  });

  it('extracts 2-hop subgraph', async () => {
    await store.putRelationship(makeRel(a.id, b.id));
    await store.putRelationship(makeRel(b.id, c.id));
    await store.putRelationship(makeRel(c.id, d.id));

    const result = await extractSubgraph(store, [a.id], { max_hops: 2 });
    const names = result.entities.map((e) => e.name).sort();
    expect(names).toEqual(['A', 'B', 'C']);
    expect(result.relationships).toHaveLength(2);
  });

  it('handles cycles without infinite loop', async () => {
    await store.putRelationship(makeRel(a.id, b.id));
    await store.putRelationship(makeRel(b.id, c.id));
    await store.putRelationship(makeRel(c.id, a.id)); // cycle

    const result = await extractSubgraph(store, [a.id], { max_hops: 5 });
    expect(result.entities).toHaveLength(3);
    expect(result.relationships).toHaveLength(3);
  });

  it('respects temporal filtering', async () => {
    const past = new Date('2023-01-01');
    const future = new Date('2025-01-01');

    await store.putRelationship(makeRel(a.id, b.id, { valid_from: past, valid_until: new Date('2024-01-01') }));
    await store.putRelationship(makeRel(a.id, c.id, { valid_from: past }));

    const result = await extractSubgraph(store, [a.id], {
      max_hops: 1,
      valid_at: future,
    });
    // Only a→c is valid at future
    const names = result.entities.map((e) => e.name).sort();
    expect(names).toEqual(['A', 'C']);
    expect(result.relationships).toHaveLength(1);
  });

  it('returns just seed entity with max_hops=0', async () => {
    await store.putRelationship(makeRel(a.id, b.id));
    const result = await extractSubgraph(store, [a.id], { max_hops: 0 });
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0].name).toBe('A');
    expect(result.relationships).toHaveLength(0);
  });

  it('caps the number of visited entities via max_entities', async () => {
    // Star graph: A connected to B, C, D — a single hop reaches 4 entities.
    await store.putRelationship(makeRel(a.id, b.id));
    await store.putRelationship(makeRel(a.id, c.id));
    await store.putRelationship(makeRel(a.id, d.id));

    const result = await extractSubgraph(store, [a.id], { max_hops: 2, max_entities: 2 });
    // Bounded: stops expanding once 2 entities have been visited.
    expect(result.entities.length).toBeLessThanOrEqual(2);
  });
});
