/**
 * Tests for EntityResolver (duplicate-entity merging with fact/relationship
 * rewrites) and its normalizeEntityName helper.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  InMemoryMemoryStore,
  InMemoryMemoryIndex,
  EntityResolver,
  normalizeEntityName,
  RuleBasedExtractor,
  ConflictDetector,
} from '../src/index.js';
import type { Episode } from '../src/index.js';
import { makeEntity, makeFact, makeRelationship } from './helpers.js';

const JAN = new Date('2024-01-01');
const JUN = new Date('2024-06-01');
const FEB = new Date('2024-02-01');
const MAY = new Date('2024-05-01');

const ID_SMALL = '00000000-0000-0000-0000-000000000001';
const ID_LARGE = '00000000-0000-0000-0000-000000000002';

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
  it('lowercases and collapses internal whitespace', () => {
    expect(normalizeEntityName('The Annual  Report')).toBe('annual report');
  });

  it('strips a leading article', () => {
    expect(normalizeEntityName('A Widget')).toBe('widget');
  });

  it('strips punctuation', () => {
    expect(normalizeEntityName('Acme Corp.')).toBe('acme corp');
    expect(normalizeEntityName("Alice's  Team!")).toBe('alices team');
  });
});

describe('EntityResolver', () => {
  let store: InMemoryMemoryStore;

  beforeEach(() => {
    store = new InMemoryMemoryStore();
  });

  it('merges entities with the same normalized name and type', async () => {
    const older = makeEntity({ name: 'Alice Smith', created_at: JAN });
    const newer = makeEntity({ name: 'alice smith', created_at: JUN });
    await store.putEntity(older);
    await store.putEntity(newer);

    const report = await new EntityResolver(store).resolve();

    expect(report.groupsMerged).toBe(1);
    expect(report.entitiesAbsorbed).toBe(1);

    const loser = await store.getEntity(newer.id);
    expect(loser?.invalidated_at).toBeDefined();
    expect(loser?.superseded_by).toBe(older.id);
    const canonical = await store.getEntity(older.id);
    expect(canonical?.invalidated_at).toBeUndefined();

    const active = await store.findEntities({ includeInvalidated: false });
    expect(active.map((e) => e.id)).toEqual([older.id]);
  });

  it('does not merge the same name with a different entity_type', async () => {
    await store.putEntity(makeEntity({ name: 'Mercury', entity_type: 'person' }));
    await store.putEntity(makeEntity({ name: 'Mercury', entity_type: 'concept' }));

    const report = await new EntityResolver(store).resolve();

    expect(report.groupsMerged).toBe(0);
  });

  it('selects the lexicographically smaller id as canonical when created_at ties', async () => {
    const first = makeEntity({ id: ID_LARGE, name: 'Alice', created_at: JAN });
    const second = makeEntity({ id: ID_SMALL, name: 'Alice', created_at: JAN });
    await store.putEntity(first);
    await store.putEntity(second);

    const report = await new EntityResolver(store).resolve();

    expect(report.groupsMerged).toBe(1);
    expect((await store.getEntity(ID_SMALL))?.invalidated_at).toBeUndefined();
    expect((await store.getEntity(ID_LARGE))?.superseded_by).toBe(ID_SMALL);
  });

  it('rewrites facts to reference the canonical entity', async () => {
    const canonical = makeEntity({ name: 'Alice', created_at: JAN });
    const dupe = makeEntity({ name: 'Alice', created_at: JUN });
    await store.putEntity(canonical);
    await store.putEntity(dupe);
    const fact = makeFact({ content: 'Alice ships features', entity_ids: [dupe.id] });
    await store.putFact(fact);

    const report = await new EntityResolver(store).resolve();
    expect(report.factsRewritten).toBe(1);

    const updated = await store.getFact(fact.id);
    expect(updated?.entity_ids).toEqual([canonical.id]);

    const byCanonical = await store.findFacts({ entity_id: canonical.id });
    expect(byCanonical.map((f) => f.id)).toEqual([fact.id]);
  });

  it('deduplicates entity_ids when a fact referenced multiple copies', async () => {
    const canonical = makeEntity({ name: 'Alice', created_at: JAN });
    const dupe = makeEntity({ name: 'Alice', created_at: JUN });
    await store.putEntity(canonical);
    await store.putEntity(dupe);
    const fact = makeFact({ content: 'Alice and Alice', entity_ids: [canonical.id, dupe.id] });
    await store.putFact(fact);

    await new EntityResolver(store).resolve();

    const updated = await store.getFact(fact.id);
    expect(updated?.entity_ids).toEqual([canonical.id]);
  });

  it('rewrites relationship endpoints to the canonical', async () => {
    const alice1 = makeEntity({ name: 'Alice', created_at: JAN });
    const alice2 = makeEntity({ name: 'Alice', created_at: JUN });
    const acme = makeEntity({ name: 'Acme Corp', entity_type: 'organization' });
    await store.putEntity(alice1);
    await store.putEntity(alice2);
    await store.putEntity(acme);
    const rel = makeRelationship({ source_id: alice2.id, target_id: acme.id });
    await store.putRelationship(rel);

    const report = await new EntityResolver(store).resolve();
    expect(report.relationshipsRewritten).toBe(1);

    const updated = await store.getRelationship(rel.id);
    expect(updated?.source_id).toBe(alice1.id);

    const rels = await store.getRelationshipsForEntity(alice1.id, { direction: 'both' });
    expect(rels.map((r) => r.id)).toEqual([rel.id]);
  });

  it('orders rewritten relationships by valid_from', async () => {
    const alice1 = makeEntity({ name: 'Alice', created_at: JAN });
    const alice2 = makeEntity({ name: 'Alice', created_at: JUN });
    await store.putEntity(alice1);
    await store.putEntity(alice2);
    const bob = crypto.randomUUID();
    const carol = crypto.randomUUID();
    await store.putRelationship(makeRelationship({ source_id: alice2.id, target_id: bob, valid_from: FEB }));
    await store.putRelationship(makeRelationship({ source_id: alice2.id, target_id: carol, valid_from: MAY }));

    const report = await new EntityResolver(store).resolve();

    expect(report.relationshipsRewritten).toBe(2);
    expect(report.relationshipsDropped).toBe(0);
  });

  it('breaks rewritten-relationship ties by id when valid_from matches', async () => {
    const alice1 = makeEntity({ name: 'Alice', created_at: JAN });
    const alice2 = makeEntity({ name: 'Alice', created_at: JUN });
    await store.putEntity(alice1);
    await store.putEntity(alice2);
    const bob = crypto.randomUUID();
    const carol = crypto.randomUUID();
    await store.putRelationship(makeRelationship({ id: ID_SMALL, source_id: alice2.id, target_id: bob, valid_from: FEB }));
    await store.putRelationship(makeRelationship({ id: ID_LARGE, source_id: alice2.id, target_id: carol, valid_from: FEB }));

    const report = await new EntityResolver(store).resolve();

    expect(report.relationshipsRewritten).toBe(2);
    expect(report.relationshipsDropped).toBe(0);
  });

  it('collects an edge between two losers of the same group only once', async () => {
    const canonical = makeEntity({ name: 'Alice', created_at: JAN });
    const loserA = makeEntity({ name: 'Alice', created_at: JUN });
    const loserB = makeEntity({ name: 'Alice', created_at: new Date('2024-09-01') });
    await store.putEntity(canonical);
    await store.putEntity(loserA);
    await store.putEntity(loserB);
    const rel = makeRelationship({ source_id: loserA.id, target_id: loserB.id, relation_type: 'collaborate_with' });
    await store.putRelationship(rel);

    const report = await new EntityResolver(store).resolve();

    expect(report.entitiesAbsorbed).toBe(2);
    expect(report.relationshipsDropped).toBe(1);
    expect(await store.getRelationship(rel.id)).toBeNull();
  });

  it('drops self-loops created by merging both endpoints', async () => {
    const alice1 = makeEntity({ name: 'Alice', created_at: JAN });
    const alice2 = makeEntity({ name: 'Alice', created_at: JUN });
    await store.putEntity(alice1);
    await store.putEntity(alice2);
    const rel = makeRelationship({ source_id: alice1.id, target_id: alice2.id, relation_type: 'collaborate_with' });
    await store.putRelationship(rel);

    const report = await new EntityResolver(store).resolve();

    expect(report.relationshipsDropped).toBe(1);
    expect(await store.getRelationship(rel.id)).toBeNull();
  });

  it('drops a rewritten edge that duplicates an existing canonical edge', async () => {
    const alice1 = makeEntity({ name: 'Alice', created_at: JAN });
    const alice2 = makeEntity({ name: 'Alice', created_at: JUN });
    const acme = makeEntity({ name: 'Acme Corp', entity_type: 'organization' });
    await store.putEntity(alice1);
    await store.putEntity(alice2);
    await store.putEntity(acme);
    const existing = makeRelationship({ source_id: alice1.id, target_id: acme.id });
    const duplicate = makeRelationship({ source_id: alice2.id, target_id: acme.id });
    await store.putRelationship(existing);
    await store.putRelationship(duplicate);

    const report = await new EntityResolver(store).resolve();

    expect(report.relationshipsDropped).toBe(1);
    expect(await store.getRelationship(existing.id)).not.toBeNull();
    expect(await store.getRelationship(duplicate.id)).toBeNull();
  });

  it('hard delete mode removes losers without cascading rewritten edges', async () => {
    const alice1 = makeEntity({ name: 'Alice', created_at: JAN });
    const alice2 = makeEntity({ name: 'Alice', created_at: JUN });
    const acme = makeEntity({ name: 'Acme Corp', entity_type: 'organization' });
    await store.putEntity(alice1);
    await store.putEntity(alice2);
    await store.putEntity(acme);
    const rel = makeRelationship({ source_id: alice2.id, target_id: acme.id });
    await store.putRelationship(rel);

    await new EntityResolver(store, { deleteMode: 'hard' }).resolve();

    expect(await store.getEntity(alice2.id)).toBeNull();
    expect((await store.getRelationship(rel.id))?.source_id).toBe(alice1.id);
  });

  it('absorbs loser attributes without overwriting canonical values', async () => {
    const canonical = makeEntity({ name: 'Alice', created_at: JAN, attributes: { role: 'engineer' } });
    const dupe = makeEntity({ name: 'Alice', created_at: JUN, attributes: { role: 'manager', team: 'platform' }, embedding: [1, 0, 0] });
    await store.putEntity(canonical);
    await store.putEntity(dupe);

    await new EntityResolver(store).resolve();

    const merged = await store.getEntity(canonical.id);
    expect(merged?.attributes).toEqual({ role: 'engineer', team: 'platform' });
    expect(merged?.embedding).toEqual([1, 0, 0]);
  });

  it('is idempotent across a second resolve pass', async () => {
    await store.putEntity(makeEntity({ name: 'Alice', created_at: JAN }));
    await store.putEntity(makeEntity({ name: 'Alice', created_at: JUN }));

    await new EntityResolver(store).resolve();
    const second = await new EntityResolver(store).resolve();

    expect(second.groupsMerged).toBe(0);
    expect(second.entitiesAbsorbed).toBe(0);
  });

  it('paginates entity loading across batch boundaries', async () => {
    await store.putEntity(makeEntity({ name: 'Alice', created_at: JAN }));
    await store.putEntity(makeEntity({ name: 'Alice', created_at: JUN }));
    await store.putEntity(makeEntity({ name: 'Bob' }));

    const report = await new EntityResolver(store, { batchSize: 2 }).resolve();

    expect(report.groupsMerged).toBe(1);
    expect(report.entitiesAbsorbed).toBe(1);
  });

  it('paginates fact rewrites across batch boundaries', async () => {
    const canonical = makeEntity({ name: 'Alice', created_at: JAN });
    const dupe = makeEntity({ name: 'Alice', created_at: JUN });
    await store.putEntity(canonical);
    await store.putEntity(dupe);
    await store.putFact(makeFact({ content: 'fact one', entity_ids: [dupe.id] }));
    await store.putFact(makeFact({ content: 'fact two', entity_ids: [dupe.id] }));
    await store.putFact(makeFact({ content: 'fact three', entity_ids: [dupe.id] }));

    const report = await new EntityResolver(store, { batchSize: 2 }).resolve();

    expect(report.factsRewritten).toBe(3);
    const byCanonical = await store.findFacts({ entity_id: canonical.id });
    expect(byCanonical).toHaveLength(3);
  });

  describe('cross-episode integration', () => {
    it('extraction then resolution then detection finds a cross-episode contradiction', async () => {
      const index = new InMemoryMemoryIndex();
      const extractor = new RuleBasedExtractor();

      const ep1 = makeEpisode('Alice Smith works at Acme Corp on the platform team.', new Date('2024-01-15'));
      const ep2 = makeEpisode('Alice Smith does not work at Acme Corp anymore these days.', new Date('2024-03-15'));

      for (const ep of [ep1, ep2]) {
        const result = await extractor.extract(ep);
        for (const entity of result.entities) await store.putEntity(entity);
        for (const fact of result.facts) await store.putFact(fact);
        for (const rel of result.relationships) await store.putRelationship(rel);
      }

      const before = await new ConflictDetector(store, index).detectConflicts();
      expect(before).toHaveLength(0);

      const report = await new EntityResolver(store).resolve();
      expect(report.groupsMerged).toBeGreaterThanOrEqual(1);

      const after = await new ConflictDetector(store, index).detectConflicts();
      const negations = after.filter((c) => c.type === 'negation');
      expect(negations).toHaveLength(1);

      const contents = [negations[0].factA.content, negations[0].factB.content];
      expect(contents.some((c) => c.includes('works at Acme Corp'))).toBe(true);
      expect(contents.some((c) => c.includes('does not work at Acme Corp'))).toBe(true);
    });
  });
});
