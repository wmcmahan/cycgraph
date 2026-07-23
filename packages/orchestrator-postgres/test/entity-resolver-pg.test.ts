/**
 * EntityResolver × DrizzleMemoryStore Integration Tests
 *
 * The resolver's rewrite path exercises backend-specific machinery the
 * in-memory store doesn't have — most importantly putFact's
 * memory_entity_facts join-table resync, which entity-scoped fact lookup
 * (findFacts({ entity_id })) depends on. Skipped without DATABASE_URL.
 */

import { describe, test, expect } from 'vitest';
import { setupDatabaseTests, isDatabaseAvailable } from './setup.js';
import { DrizzleMemoryStore } from '../src/drizzle-memory-store.js';
import { EntityResolver } from '@cycgraph/memory';
import { randomUUID } from 'node:crypto';
import type { Entity, Relationship, SemanticFact, Provenance } from '@cycgraph/memory';

const prov: Provenance = { source: 'derived', created_at: new Date('2024-01-01') };

function makeEntity(name: string, overrides: Partial<Entity> = {}): Entity {
  const now = new Date('2024-01-01');
  return {
    id: randomUUID(),
    name,
    entity_type: 'person',
    attributes: {},
    provenance: prov,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function makeFact(content: string, entityIds: string[]): SemanticFact {
  return {
    id: randomUUID(),
    content,
    source_episode_ids: [],
    entity_ids: entityIds,
    provenance: prov,
    valid_from: new Date('2024-01-01'),
    tags: [],
    access_count: 0,
  };
}

function makeRel(sourceId: string, targetId: string): Relationship {
  return {
    id: randomUUID(),
    source_id: sourceId,
    target_id: targetId,
    relation_type: 'work_at',
    weight: 1,
    attributes: {},
    valid_from: new Date('2024-01-01'),
    provenance: prov,
  };
}

describe.skipIf(!isDatabaseAvailable())('EntityResolver × DrizzleMemoryStore', () => {
  setupDatabaseTests();
  const store = new DrizzleMemoryStore();

  test('merges duplicates, resyncs the entity_facts join table, rewrites edges', async () => {
    const canonical = makeEntity('Alice Smith', { created_at: new Date('2024-01-01') });
    const dupe = makeEntity('alice smith', { created_at: new Date('2024-06-01') });
    const acme = makeEntity('Acme Corp', { entity_type: 'organization' });
    await store.putEntity(canonical);
    await store.putEntity(dupe);
    await store.putEntity(acme);

    const fact = makeFact('Alice Smith works at Acme Corp', [dupe.id, acme.id]);
    await store.putFact(fact);
    const rel = makeRel(dupe.id, acme.id);
    await store.putRelationship(rel);

    const report = await new EntityResolver(store).resolve();
    expect(report.groupsMerged).toBe(1);
    expect(report.entitiesAbsorbed).toBe(1);
    expect(report.factsRewritten).toBe(1);
    expect(report.relationshipsRewritten).toBe(1);

    // Loser soft-deleted with forwarding pointer; excluded from default listing.
    const loser = await store.getEntity(dupe.id);
    expect(loser!.invalidated_at).toBeDefined();
    expect(loser!.superseded_by).toBe(canonical.id);
    const active = await store.findEntities({ includeInvalidated: false });
    expect(active.map((e) => e.id).sort()).toEqual([acme.id, canonical.id].sort());

    // Fact remapped — and the join-table resync must follow: entity-scoped
    // lookup works through the canonical, returns nothing for the loser.
    const updatedFact = await store.getFact(fact.id);
    expect(updatedFact!.entity_ids.sort()).toEqual([acme.id, canonical.id].sort());
    const byCanonical = await store.findFacts({ entityId: canonical.id });
    expect(byCanonical.map((f) => f.id)).toEqual([fact.id]);
    expect(await store.findFacts({ entityId: dupe.id })).toHaveLength(0);

    // Relationship endpoint rewritten; BFS from the canonical traverses it.
    const updatedRel = await store.getRelationship(rel.id);
    expect(updatedRel!.source_id).toBe(canonical.id);
    const rels = await store.getRelationshipsForEntity(canonical.id, { direction: 'both' });
    expect(rels.map((r) => r.id)).toEqual([rel.id]);
  });

  test('drops self-loops and duplicate edges against existing canonical edges', async () => {
    const alice1 = makeEntity('Alice', { created_at: new Date('2024-01-01') });
    const alice2 = makeEntity('Alice', { created_at: new Date('2024-06-01') });
    const acme = makeEntity('Acme Corp', { entity_type: 'organization' });
    await store.putEntity(alice1);
    await store.putEntity(alice2);
    await store.putEntity(acme);

    const selfLoop = makeRel(alice1.id, alice2.id);        // collapses onto one canonical
    const existing = makeRel(alice1.id, acme.id);          // canonical already has this edge
    const duplicate = makeRel(alice2.id, acme.id);         // rewrites to the same key
    await store.putRelationship(selfLoop);
    await store.putRelationship(existing);
    await store.putRelationship(duplicate);

    const report = await new EntityResolver(store).resolve();
    expect(report.relationshipsDropped).toBe(2);
    expect(await store.getRelationship(selfLoop.id)).toBeNull();
    expect(await store.getRelationship(duplicate.id)).toBeNull();
    expect(await store.getRelationship(existing.id)).not.toBeNull();
  });

  test('second resolve pass is a no-op (idempotent against the DB)', async () => {
    await store.putEntity(makeEntity('Alice', { created_at: new Date('2024-01-01') }));
    await store.putEntity(makeEntity('Alice', { created_at: new Date('2024-06-01') }));

    await new EntityResolver(store).resolve();
    const second = await new EntityResolver(store).resolve();
    expect(second.groupsMerged).toBe(0);
    expect(second.entitiesAbsorbed).toBe(0);
  });
});
