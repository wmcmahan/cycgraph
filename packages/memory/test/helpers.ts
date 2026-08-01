/**
 * Shared test helpers for the memory suites: deterministic record builders.
 */

import type {
  Entity,
  Episode,
  Message,
  Provenance,
  Relationship,
  SemanticFact,
  Theme,
} from '../src/schemas/index.js';

export const FIXED_DATE = new Date('2024-01-01T00:00:00.000Z');

export function makeProvenance(overrides: Partial<Provenance> = {}): Provenance {
  return { source: 'agent', created_at: FIXED_DATE, ...overrides };
}

export function makeEntity(overrides: Partial<Entity> = {}): Entity {
  return {
    id: crypto.randomUUID(),
    name: 'Alice',
    entity_type: 'person',
    attributes: {},
    provenance: makeProvenance(),
    created_at: FIXED_DATE,
    updated_at: FIXED_DATE,
    ...overrides,
  };
}

export function makeFact(overrides: Partial<SemanticFact> = {}): SemanticFact {
  return {
    id: crypto.randomUUID(),
    content: 'Alice works at Acme',
    source_episode_ids: [],
    entity_ids: [],
    provenance: makeProvenance(),
    valid_from: FIXED_DATE,
    tags: [],
    ...overrides,
  };
}

export function makeTheme(overrides: Partial<Theme> = {}): Theme {
  return {
    id: crypto.randomUUID(),
    label: 'Work',
    description: '',
    fact_ids: [],
    provenance: makeProvenance(),
    ...overrides,
  };
}

export function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: crypto.randomUUID(),
    role: 'user',
    content: 'Hello',
    timestamp: FIXED_DATE,
    metadata: {},
    ...overrides,
  };
}

export function makeEpisode(overrides: Partial<Episode> = {}): Episode {
  return {
    id: crypto.randomUUID(),
    topic: 'General',
    messages: [],
    started_at: FIXED_DATE,
    ended_at: FIXED_DATE,
    fact_ids: [],
    provenance: makeProvenance(),
    ...overrides,
  };
}

export function makeRelationship(overrides: Partial<Relationship> = {}): Relationship {
  return {
    id: crypto.randomUUID(),
    source_id: crypto.randomUUID(),
    target_id: crypto.randomUUID(),
    relation_type: 'works_at',
    weight: 1,
    attributes: {},
    valid_from: FIXED_DATE,
    provenance: makeProvenance(),
    ...overrides,
  };
}
