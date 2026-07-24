import { describe, it, expect, beforeEach } from 'vitest';
import {
  InMemoryMemoryStore,
  InMemoryMemoryIndex,
  EntityResolver,
  normalizeEntityName,
  RuleBasedExtractor,
  ConflictDetector,
} from '../src/index.js';
import type { Entity, Relationship, SemanticFact, Episode, Provenance } from '../src/index.js';

const prov: Provenance = { source: 'derived', created_at: new Date('2024-01-01') };

function makeEntity(name: string, overrides: Partial<Entity> = {}): Entity {
  const now = new Date('2024-01-01');
  return {
    id: crypto.randomUUID(),
    name,
    entity_type: 'person',
    attributes: {},
    provenance: prov,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function makeFact(content: string, entityIds: string[], overrides: Partial<SemanticFact> = {}): SemanticFact {
  return {
    id: crypto.randomUUID(),
    content,
    source_episode_ids: [],
    entity_ids: entityIds,
    provenance: prov,
    valid_from: new Date('2024-01-01'),
    tags: [],
    ...overrides,
  };
}

function makeRel(sourceId: string, targetId: string, overrides: Partial<Relationship> = {}): Relationship {
  return {
    id: crypto.randomUUID(),
    source_id: sourceId,
    target_id: targetId,
    relation_type: 'work_at',
    weight: 1,
    attributes: {},
    valid_from: new Date('2024-01-01'),
    provenance: prov,
    ...overrides,
  };
}

function makeEpisode(content: string, startedAt: Date): Episode {
  return {
    id: crypto.randomUUID(),
    topic: content.slice(0, 50),
    messages: [{
      id: crypto.randomUUID(),
      role: 'user',
      content,
      timestamp: startedAt,
      metadata: {},
    }],
    started_at: startedAt,
    ended_at: startedAt,
    fact_ids: [],
    provenance: { source: 'human', created_at: startedAt },
  };
}

describe('normalizeEntityName', () => {
  it('lowercases, strips leading articles and punctuation, collapses whitespace', () => {
    expect(normalizeEntityName('The Annual  Report')).toBe('annual report');
    expect(normalizeEntityName('Acme Corp.')).toBe('acme corp');
    expect(normalizeEntityName("Alice's  Team!")).toBe('alices team');
    expect(normalizeEntityName('A Widget')).toBe('widget');
  });
});

describe('EntityResolver', () => {
  let store: InMemoryMemoryStore;

  beforeEach(() => {
    store = new InMemoryMemoryStore();
  });

  it('merges entities with the same normalized name and type', async () => {
    const older = makeEntity('Alice Smith', { created_at: new Date('2024-01-01') });
    const newer = makeEntity('alice smith', { created_at: new Date('2024-06-01') });
    await store.putEntity(older);
    await store.putEntity(newer);

    const report = await new EntityResolver(store).resolve();

    expect(report.groupsMerged).toBe(1);
    expect(report.entitiesAbsorbed).toBe(1);

    // Canonical = oldest created_at; loser soft-deleted with forwarding pointer.
    const loser = await store.getEntity(newer.id);
    expect(loser?.invalidated_at).toBeDefined();
    expect(loser?.superseded_by).toBe(older.id);
    const canonical = await store.getEntity(older.id);
    expect(canonical?.invalidated_at).toBeUndefined();

    // Default listings no longer show the duplicate.
    const active = await store.findEntities({ includeInvalidated: false });
    expect(active.map((e) => e.id)).toEqual([older.id]);
  });

  it('does not merge same name with different entity_type', async () => {
    await store.putEntity(makeEntity('Mercury', { entity_type: 'person' }));
    await store.putEntity(makeEntity('Mercury', { entity_type: 'concept' }));

    const report = await new EntityResolver(store).resolve();
    expect(report.groupsMerged).toBe(0);
  });

  it('rewrites facts to reference the canonical entity', async () => {
    const canonical = makeEntity('Alice', { created_at: new Date('2024-01-01') });
    const dupe = makeEntity('Alice', { created_at: new Date('2024-06-01') });
    await store.putEntity(canonical);
    await store.putEntity(dupe);
    const fact = makeFact('Alice ships features', [dupe.id]);
    await store.putFact(fact);

    const report = await new EntityResolver(store).resolve();
    expect(report.factsRewritten).toBe(1);

    const updated = await store.getFact(fact.id);
    expect(updated?.entity_ids).toEqual([canonical.id]);

    // Entity-scoped fact lookup now works through the canonical.
    const byCanonical = await store.findFacts({ entity_id: canonical.id });
    expect(byCanonical.map((f) => f.id)).toEqual([fact.id]);
  });

  it('deduplicates entity_ids when a fact referenced multiple copies', async () => {
    const canonical = makeEntity('Alice', { created_at: new Date('2024-01-01') });
    const dupe = makeEntity('Alice', { created_at: new Date('2024-06-01') });
    await store.putEntity(canonical);
    await store.putEntity(dupe);
    const fact = makeFact('Alice and Alice', [canonical.id, dupe.id]);
    await store.putFact(fact);

    await new EntityResolver(store).resolve();
    const updated = await store.getFact(fact.id);
    expect(updated?.entity_ids).toEqual([canonical.id]);
  });

  it('rewrites relationship endpoints to the canonical', async () => {
    const alice1 = makeEntity('Alice', { created_at: new Date('2024-01-01') });
    const alice2 = makeEntity('Alice', { created_at: new Date('2024-06-01') });
    const acme = makeEntity('Acme Corp', { entity_type: 'organization' });
    await store.putEntity(alice1);
    await store.putEntity(alice2);
    await store.putEntity(acme);
    const rel = makeRel(alice2.id, acme.id);
    await store.putRelationship(rel);

    const report = await new EntityResolver(store).resolve();
    expect(report.relationshipsRewritten).toBe(1);

    const updated = await store.getRelationship(rel.id);
    expect(updated?.source_id).toBe(alice1.id);

    // BFS from the canonical now traverses the rewritten edge.
    const rels = await store.getRelationshipsForEntity(alice1.id, { direction: 'both' });
    expect(rels.map((r) => r.id)).toEqual([rel.id]);
  });

  it('drops self-loops created by merging both endpoints', async () => {
    const alice1 = makeEntity('Alice', { created_at: new Date('2024-01-01') });
    const alice2 = makeEntity('Alice', { created_at: new Date('2024-06-01') });
    await store.putEntity(alice1);
    await store.putEntity(alice2);
    const rel = makeRel(alice1.id, alice2.id, { relation_type: 'collaborate_with' });
    await store.putRelationship(rel);

    const report = await new EntityResolver(store).resolve();
    expect(report.relationshipsDropped).toBe(1);
    expect(await store.getRelationship(rel.id)).toBeNull();
  });

  it('drops a rewritten edge that duplicates an existing canonical edge', async () => {
    const alice1 = makeEntity('Alice', { created_at: new Date('2024-01-01') });
    const alice2 = makeEntity('Alice', { created_at: new Date('2024-06-01') });
    const acme = makeEntity('Acme Corp', { entity_type: 'organization' });
    await store.putEntity(alice1);
    await store.putEntity(alice2);
    await store.putEntity(acme);
    const existing = makeRel(alice1.id, acme.id); // canonical already has this edge
    const duplicate = makeRel(alice2.id, acme.id); // rewrites to the same key
    await store.putRelationship(existing);
    await store.putRelationship(duplicate);

    const report = await new EntityResolver(store).resolve();
    expect(report.relationshipsDropped).toBe(1);
    expect(await store.getRelationship(existing.id)).not.toBeNull();
    expect(await store.getRelationship(duplicate.id)).toBeNull();
  });

  it('hard delete mode removes losers outright without cascading rewritten edges', async () => {
    const alice1 = makeEntity('Alice', { created_at: new Date('2024-01-01') });
    const alice2 = makeEntity('Alice', { created_at: new Date('2024-06-01') });
    const acme = makeEntity('Acme Corp', { entity_type: 'organization' });
    await store.putEntity(alice1);
    await store.putEntity(alice2);
    await store.putEntity(acme);
    const rel = makeRel(alice2.id, acme.id);
    await store.putRelationship(rel);

    await new EntityResolver(store, { deleteMode: 'hard' }).resolve();

    expect(await store.getEntity(alice2.id)).toBeNull();
    // The rewritten edge survives the loser's deletion.
    const updated = await store.getRelationship(rel.id);
    expect(updated?.source_id).toBe(alice1.id);
  });

  it('absorbs loser attributes without overwriting canonical values', async () => {
    const canonical = makeEntity('Alice', {
      created_at: new Date('2024-01-01'),
      attributes: { role: 'engineer' },
    });
    const dupe = makeEntity('Alice', {
      created_at: new Date('2024-06-01'),
      attributes: { role: 'manager', team: 'platform' },
      embedding: [1, 0, 0],
    });
    await store.putEntity(canonical);
    await store.putEntity(dupe);

    await new EntityResolver(store).resolve();
    const merged = await store.getEntity(canonical.id);
    expect(merged?.attributes).toEqual({ role: 'engineer', team: 'platform' });
    expect(merged?.embedding).toEqual([1, 0, 0]); // inherited — canonical had none
  });

  it('is idempotent: a second resolve pass is a no-op', async () => {
    await store.putEntity(makeEntity('Alice', { created_at: new Date('2024-01-01') }));
    await store.putEntity(makeEntity('Alice', { created_at: new Date('2024-06-01') }));

    await new EntityResolver(store).resolve();
    const second = await new EntityResolver(store).resolve();
    expect(second.groupsMerged).toBe(0);
    expect(second.entitiesAbsorbed).toBe(0);
  });

  describe('cross-episode integration (the reason this component exists)', () => {
    it('extraction → resolution → conflict detection finds a cross-episode contradiction', async () => {
      const index = new InMemoryMemoryIndex();
      const extractor = new RuleBasedExtractor();

      // Two episodes, months apart, contradicting each other. Extraction
      // mints DIFFERENT entity UUIDs for "Alice Smith" in each.
      const ep1 = makeEpisode('Alice Smith works at Acme Corp on the platform team.', new Date('2024-01-15'));
      const ep2 = makeEpisode('Alice Smith does not work at Acme Corp anymore these days.', new Date('2024-03-15'));

      for (const ep of [ep1, ep2]) {
        const result = await extractor.extract(ep);
        for (const entity of result.entities) await store.putEntity(entity);
        for (const fact of result.facts) await store.putFact(fact);
        for (const rel of result.relationships) await store.putRelationship(rel);
      }

      // Sanity: without resolution, no conflicts are visible (disjoint entity ids).
      const before = await new ConflictDetector(store, index).detectConflicts();
      expect(before).toHaveLength(0);

      const report = await new EntityResolver(store).resolve();
      expect(report.groupsMerged).toBeGreaterThanOrEqual(1); // at least Alice Smith

      // With shared canonical entities, the negation conflict surfaces.
      const after = await new ConflictDetector(store, index).detectConflicts();
      const negations = after.filter((c) => c.type === 'negation');
      expect(negations).toHaveLength(1);
      const contents = [negations[0].factA.content, negations[0].factB.content];
      expect(contents.some((c) => c.includes('works at Acme Corp'))).toBe(true);
      expect(contents.some((c) => c.includes('does not work at Acme Corp'))).toBe(true);
    });
  });
});
