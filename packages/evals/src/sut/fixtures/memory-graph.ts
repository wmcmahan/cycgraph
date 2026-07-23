/**
 * Memory Graph Fixture
 *
 * Shared seeded `InMemoryMemoryStore` for subgraph / consolidation /
 * conflict trajectory recording. The fixture mirrors the entity graph
 * the existing memory eval suite uses (Alice/Bob/Acme/Widget) so that
 * trajectory inputs referencing `e-alice` etc. resolve against a
 * consistent canonical world.
 *
 * Entity / relationship / fact IDs use the same string-key convention
 * as the memory suite's internal fixtures — the in-memory store does
 * not enforce schema-level UUID validation on put, so these keys stay
 * matchable against trajectory inputs.
 *
 * @module sut/fixtures/memory-graph
 */

import { InMemoryMemoryStore, InMemoryMemoryIndex } from '@cycgraph/memory';
import type {
  Entity,
  Relationship,
  SemanticFact,
} from '@cycgraph/memory';

/** Canonical fixture timestamps; align with the existing memory suite. */
export const FIXTURE_NOW = new Date('2026-04-06T12:00:00Z');
export const FIXTURE_PAST = new Date('2025-01-01T00:00:00Z');
export const FIXTURE_FUTURE = new Date('2027-01-01T00:00:00Z');

function makeEntity(id: string, name: string, type: string): Entity {
  return {
    id,
    name,
    entity_type: type,
    attributes: {},
    provenance: { source: 'system', created_at: FIXTURE_NOW },
    created_at: FIXTURE_NOW,
    updated_at: FIXTURE_NOW,
  };
}

function makeRelationship(
  id: string,
  sourceId: string,
  targetId: string,
  relType: string,
  validFrom: Date,
  validUntil?: Date,
): Relationship {
  return {
    id,
    source_id: sourceId,
    target_id: targetId,
    relation_type: relType,
    weight: 1.0,
    attributes: {},
    valid_from: validFrom,
    valid_until: validUntil,
    provenance: { source: 'system', created_at: FIXTURE_NOW },
  };
}

function makeFact(
  id: string,
  content: string,
  entityIds: string[],
  validFrom: Date,
  validUntil?: Date,
  invalidatedBy?: string,
): SemanticFact {
  return {
    id,
    content,
    source_episode_ids: [],
    entity_ids: entityIds,
    provenance: { source: 'system', created_at: FIXTURE_NOW },
    valid_from: validFrom,
    valid_until: validUntil,
    invalidated_by: invalidatedBy,
    tags: [],
  };
}

/**
 * Build a freshly-seeded memory store + index containing the canonical
 * entity graph used by every trajectory referencing string IDs like
 * `e-alice`. Re-call this per handler invocation — there is no shared
 * mutable state between calls.
 */
export async function buildSeededMemoryGraph(): Promise<{
  store: InMemoryMemoryStore;
  index: InMemoryMemoryIndex;
}> {
  const store = new InMemoryMemoryStore();
  const index = new InMemoryMemoryIndex();

  const entities: Entity[] = [
    makeEntity('e-alice', 'Alice', 'person'),
    makeEntity('e-bob', 'Bob', 'person'),
    makeEntity('e-acme', 'Acme Corp', 'organization'),
    makeEntity('e-widget', 'Widget Project', 'project'),
  ];
  for (const e of entities) await store.putEntity(e);

  const relationships: Relationship[] = [
    makeRelationship('r-1', 'e-alice', 'e-acme', 'works_at', FIXTURE_PAST),
    makeRelationship('r-2', 'e-bob', 'e-acme', 'works_at', FIXTURE_PAST),
    makeRelationship('r-3', 'e-acme', 'e-widget', 'owns', FIXTURE_PAST),
    // Expired relationship — included so subgraph trajectories with validAt
    // can verify that expired edges are excluded.
    makeRelationship('r-4', 'e-alice', 'e-bob', 'manages', FIXTURE_PAST, FIXTURE_PAST),
  ];
  for (const r of relationships) await store.putRelationship(r);

  const facts: SemanticFact[] = [
    makeFact('f-1', 'Alice works at Acme Corp as lead engineer', ['e-alice', 'e-acme'], FIXTURE_PAST),
    makeFact('f-2', 'Bob was hired in 2024', ['e-bob'], FIXTURE_PAST, FIXTURE_PAST),
    makeFact('f-3', 'Acme Corp develops the Widget Project', ['e-acme', 'e-widget'], FIXTURE_PAST),
  ];
  for (const f of facts) await store.putFact(f);

  await index.rebuild(store);

  return { store, index };
}
