/**
 * Tests for ConflictDetector: negation, temporal supersession, and
 * embedding-based semantic-contradiction detection, plus manual resolution.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryMemoryStore } from '../src/store/in-memory-store.js';
import { InMemoryMemoryIndex } from '../src/search/in-memory-index.js';
import { ConflictDetector } from '../src/consolidation/conflict-detector.js';
import { QUARANTINE_TAG } from '../src/interfaces/memory-store.js';
import type { SemanticFact } from '../src/schemas/semantic.js';
import { makeFact } from './helpers.js';

const ENTITY_A = crypto.randomUUID();
const ENTITY_B = crypto.randomUUID();

const OLD = new Date('2024-01-01T00:00:00.000Z');
const NEW = new Date('2024-03-01T00:00:00.000Z');
const SAME_DAY_MORNING = new Date('2024-01-01T00:00:00.000Z');
const SAME_DAY_EVENING = new Date('2024-01-01T12:00:00.000Z');

const SIMILAR_EMBEDDING_A = [1, 0, 0];
const SIMILAR_EMBEDDING_B = [0.95, 0.3, 0];

describe('ConflictDetector', () => {
  let store: InMemoryMemoryStore;
  let index: InMemoryMemoryIndex;

  beforeEach(() => {
    store = new InMemoryMemoryStore();
    index = new InMemoryMemoryIndex();
  });

  async function seed(facts: SemanticFact[]): Promise<void> {
    for (const fact of facts) await store.putFact(fact);
    await index.rebuild(store);
  }

  describe('negation detection', () => {
    it('detects negation between an affirmative and a negative fact', async () => {
      await seed([
        makeFact({ content: 'Alice works at Acme', entity_ids: [ENTITY_A] }),
        makeFact({ content: 'Alice no longer works at Acme', entity_ids: [ENTITY_A] }),
      ]);

      const conflicts = await new ConflictDetector(store, index).detectConflicts();

      const negations = conflicts.filter((c) => c.type === 'negation');
      expect(negations).toHaveLength(1);
      expect(negations[0].confidence).toBe(0.8);
    });

    it('detects contraction and keyword negation patterns', async () => {
      const pairs: [string, string][] = [
        ['Alice likes cats', "Alice doesn't like cats"],
        ['The system is working', "The system isn't working"],
        ['Users can access data', 'Users cannot access data'],
      ];

      for (const [affirmative, negative] of pairs) {
        await store.clear();
        await seed([
          makeFact({ content: affirmative, entity_ids: [ENTITY_A] }),
          makeFact({ content: negative, entity_ids: [ENTITY_A] }),
        ]);

        const conflicts = await new ConflictDetector(store, index).detectConflicts();

        expect(conflicts.filter((c) => c.type === 'negation')).toHaveLength(1);
      }
    });

    it('does not detect negation between unrelated facts', async () => {
      await seed([
        makeFact({ content: 'Alice works at Acme', entity_ids: [ENTITY_A] }),
        makeFact({ content: 'The weather is sunny today', entity_ids: [ENTITY_A] }),
      ]);

      const conflicts = await new ConflictDetector(store, index).detectConflicts();

      expect(conflicts.filter((c) => c.type === 'negation')).toHaveLength(0);
    });

    it('requires a shared entity_id for negation detection', async () => {
      await seed([
        makeFact({ content: 'Alice works at Acme', entity_ids: [ENTITY_A] }),
        makeFact({ content: 'Alice not works at Acme', entity_ids: [ENTITY_B] }),
      ]);

      const conflicts = await new ConflictDetector(store, index).detectConflicts();

      expect(conflicts).toHaveLength(0);
    });

    it('does not flag negation when the other fact has no comparable tokens', async () => {
      await seed([
        makeFact({ content: 'Login cannot complete', entity_ids: [ENTITY_A] }),
        makeFact({ content: 'the and or', entity_ids: [ENTITY_A] }),
      ]);

      const conflicts = await new ConflictDetector(store, index).detectConflicts();

      expect(conflicts.filter((c) => c.type === 'negation')).toHaveLength(0);
    });
  });

  describe('temporal supersession', () => {
    it('detects supersession for same-entity similar facts more than a day apart', async () => {
      await seed([
        makeFact({ content: 'Alice works at Acme Corp', entity_ids: [ENTITY_A], valid_from: OLD }),
        makeFact({ content: 'Alice works at Beta Corp', entity_ids: [ENTITY_A], valid_from: NEW }),
      ]);

      const conflicts = await new ConflictDetector(store, index).detectConflicts();

      const supersessions = conflicts.filter((c) => c.type === 'supersession');
      expect(supersessions).toHaveLength(1);
      expect(supersessions[0].confidence).toBe(0.9);
    });

    it('does not detect supersession across different entities', async () => {
      await seed([
        makeFact({ content: 'Alice works at Acme Corp', entity_ids: [ENTITY_A], valid_from: OLD }),
        makeFact({ content: 'Bob works at Acme Corp', entity_ids: [ENTITY_B], valid_from: NEW }),
      ]);

      const conflicts = await new ConflictDetector(store, index).detectConflicts();

      expect(conflicts.filter((c) => c.type === 'supersession')).toHaveLength(0);
    });

    it('does not detect supersession for facts less than a day apart', async () => {
      await seed([
        makeFact({ content: 'Alice works at Acme Corp', entity_ids: [ENTITY_A], valid_from: SAME_DAY_MORNING }),
        makeFact({ content: 'Alice works at Beta Corp', entity_ids: [ENTITY_A], valid_from: SAME_DAY_EVENING }),
      ]);

      const conflicts = await new ConflictDetector(store, index).detectConflicts();

      expect(conflicts.filter((c) => c.type === 'supersession')).toHaveLength(0);
    });

    it('does not detect supersession when word overlap is too low', async () => {
      await seed([
        makeFact({ content: 'Alice enjoys hiking mountains', entity_ids: [ENTITY_A], valid_from: OLD }),
        makeFact({ content: 'Alice dislikes swimming pools', entity_ids: [ENTITY_A], valid_from: NEW }),
      ]);

      const conflicts = await new ConflictDetector(store, index).detectConflicts();

      expect(conflicts.filter((c) => c.type === 'supersession')).toHaveLength(0);
    });

    it('does not detect supersession when normalized content has no comparable tokens', async () => {
      await seed([
        makeFact({ content: 'the a an is', entity_ids: [ENTITY_A], valid_from: OLD }),
        makeFact({ content: 'of to in on', entity_ids: [ENTITY_A], valid_from: NEW }),
      ]);

      const conflicts = await new ConflictDetector(store, index).detectConflicts();

      expect(conflicts.filter((c) => c.type === 'supersession')).toHaveLength(0);
    });

    it('is read-only by default and does not invalidate either fact', async () => {
      const older = makeFact({ content: 'Alice works at Acme Corp', entity_ids: [ENTITY_A], valid_from: OLD });
      const newer = makeFact({ content: 'Alice works at Beta Corp', entity_ids: [ENTITY_A], valid_from: NEW });
      await seed([older, newer]);

      const conflicts = await new ConflictDetector(store, index).detectConflicts();

      expect(conflicts.filter((c) => c.type === 'supersession')).toHaveLength(1);
      expect((await store.getFact(older.id))?.invalidated_by).toBeUndefined();
      expect((await store.getFact(newer.id))?.invalidated_by).toBeUndefined();
    });

    it('auto-resolves by invalidating the older fact when it is stored first', async () => {
      const older = makeFact({ content: 'Alice works at Acme Corporation', entity_ids: [ENTITY_A], valid_from: OLD });
      const newer = makeFact({ content: 'Alice works at Acme Company', entity_ids: [ENTITY_A], valid_from: NEW });
      await seed([older, newer]);

      await new ConflictDetector(store, index, { autoResolveSupersession: true }).detectConflicts();

      expect((await store.getFact(older.id))?.invalidated_by).toBe(newer.id);
      expect((await store.getFact(newer.id))?.invalidated_by).toBeUndefined();
    });

    it('auto-resolves by invalidating the older fact when it is stored second', async () => {
      const older = makeFact({ content: 'Alice works at Acme Corporation', entity_ids: [ENTITY_A], valid_from: OLD });
      const newer = makeFact({ content: 'Alice works at Acme Company', entity_ids: [ENTITY_A], valid_from: NEW });
      await seed([newer, older]);

      await new ConflictDetector(store, index, { autoResolveSupersession: true }).detectConflicts();

      expect((await store.getFact(older.id))?.invalidated_by).toBe(newer.id);
      expect((await store.getFact(newer.id))?.invalidated_by).toBeUndefined();
    });
  });

  describe('semantic contradiction', () => {
    it('flags high embedding similarity with low text overlap as a contradiction', async () => {
      await seed([
        makeFact({ content: 'Alice is the CEO', entity_ids: [ENTITY_A], embedding: SIMILAR_EMBEDDING_A }),
        makeFact({ content: 'Junior intern position held', entity_ids: [ENTITY_A], embedding: SIMILAR_EMBEDDING_B }),
      ]);

      const conflicts = await new ConflictDetector(store, index).detectConflicts();

      const contradictions = conflicts.filter((c) => c.type === 'semantic_contradiction');
      expect(contradictions).toHaveLength(1);
      expect(contradictions[0].confidence).toBe(0.7);
    });

    it('assigns medium confidence to mid-length contradictory facts', async () => {
      await seed([
        makeFact({ content: 'Alice manages six regional distribution warehouses', entity_ids: [ENTITY_A], embedding: SIMILAR_EMBEDDING_A }),
        makeFact({ content: 'Alice abandoned twelve struggling overseas ventures', entity_ids: [ENTITY_A], embedding: SIMILAR_EMBEDDING_B }),
      ]);

      const conflicts = await new ConflictDetector(store, index).detectConflicts();

      const contradictions = conflicts.filter((c) => c.type === 'semantic_contradiction');
      expect(contradictions).toHaveLength(1);
      expect(contradictions[0].confidence).toBe(0.5);
    });

    it('assigns low confidence to long complementary facts', async () => {
      await seed([
        makeFact({ content: 'Alice manages engineering product design marketing finance operations logistics divisions', entity_ids: [ENTITY_A], embedding: SIMILAR_EMBEDDING_A }),
        makeFact({ content: 'Alice enjoys hiking swimming cycling running climbing skiing surfing kayaking', entity_ids: [ENTITY_A], embedding: SIMILAR_EMBEDDING_B }),
      ]);

      const conflicts = await new ConflictDetector(store, index).detectConflicts();

      const contradictions = conflicts.filter((c) => c.type === 'semantic_contradiction');
      expect(contradictions).toHaveLength(1);
      expect(contradictions[0].confidence).toBe(0.3);
    });

    it('does not flag a contradiction when entities differ', async () => {
      await seed([
        makeFact({ content: 'Alice is the CEO', entity_ids: [ENTITY_A], embedding: SIMILAR_EMBEDDING_A }),
        makeFact({ content: 'Junior intern position held', entity_ids: [ENTITY_B], embedding: SIMILAR_EMBEDDING_B }),
      ]);

      const conflicts = await new ConflictDetector(store, index).detectConflicts();

      expect(conflicts.filter((c) => c.type === 'semantic_contradiction')).toHaveLength(0);
    });

    it('skips facts without embeddings', async () => {
      await seed([
        makeFact({ content: 'Fact without embedding', entity_ids: [ENTITY_A] }),
        makeFact({ content: 'Another fact without embedding', entity_ids: [ENTITY_A] }),
      ]);

      const conflicts = await new ConflictDetector(store, index).detectConflicts();

      expect(conflicts.filter((c) => c.type === 'semantic_contradiction')).toHaveLength(0);
    });

    it('skips invalidated candidates surfaced by the index', async () => {
      await seed([
        makeFact({ content: 'Alice is the CEO', entity_ids: [ENTITY_A], embedding: SIMILAR_EMBEDDING_A }),
        makeFact({ content: 'Junior intern position held', entity_ids: [ENTITY_A], embedding: SIMILAR_EMBEDDING_B, invalidated_by: crypto.randomUUID() }),
      ]);

      const conflicts = await new ConflictDetector(store, index).detectConflicts();

      expect(conflicts.filter((c) => c.type === 'semantic_contradiction')).toHaveLength(0);
    });

    it('skips quarantined candidates surfaced by the index', async () => {
      await seed([
        makeFact({ content: 'Alice is the CEO', entity_ids: [ENTITY_A], embedding: SIMILAR_EMBEDDING_A }),
        makeFact({ content: 'Junior intern position held', entity_ids: [ENTITY_A], embedding: SIMILAR_EMBEDDING_B, tags: [QUARANTINE_TAG] }),
      ]);

      const conflicts = await new ConflictDetector(store, index).detectConflicts();

      expect(conflicts.filter((c) => c.type === 'semantic_contradiction')).toHaveLength(0);
    });

    it('still flags a contradiction when a candidate fact has no tags field', async () => {
      const tagged = makeFact({ content: 'Alice is the CEO', entity_ids: [ENTITY_A], embedding: SIMILAR_EMBEDDING_A });
      const tagless = makeFact({ content: 'Junior intern position held', entity_ids: [ENTITY_A], embedding: SIMILAR_EMBEDDING_B });
      delete (tagless as { tags?: string[] }).tags;
      await seed([tagged, tagless]);

      const conflicts = await new ConflictDetector(store, index).detectConflicts();

      expect(conflicts.filter((c) => c.type === 'semantic_contradiction')).toHaveLength(1);
    });

    it('flags a contradiction when overlap sits below a custom threshold', async () => {
      await seed([
        makeFact({ content: 'Alice is the CEO', entity_ids: [ENTITY_A], embedding: SIMILAR_EMBEDDING_A }),
        makeFact({ content: 'Junior intern position held', entity_ids: [ENTITY_A], embedding: SIMILAR_EMBEDDING_B }),
      ]);

      const conflicts = await new ConflictDetector(store, index, { semanticOverlapThreshold: 0.01 }).detectConflicts();

      expect(conflicts.filter((c) => c.type === 'semantic_contradiction')).toHaveLength(1);
    });

    it('flags nothing when the custom overlap threshold is zero', async () => {
      await seed([
        makeFact({ content: 'Alice is the CEO', entity_ids: [ENTITY_A], embedding: SIMILAR_EMBEDDING_A }),
        makeFact({ content: 'Junior intern position held', entity_ids: [ENTITY_A], embedding: SIMILAR_EMBEDDING_B }),
      ]);

      const conflicts = await new ConflictDetector(store, index, { semanticOverlapThreshold: 0 }).detectConflicts();

      expect(conflicts.filter((c) => c.type === 'semantic_contradiction')).toHaveLength(0);
    });
  });

  describe('detectConflicts', () => {
    it('returns an empty array for a store with no conflicts', async () => {
      await seed([
        makeFact({ content: 'Alice likes cats', entity_ids: [ENTITY_A] }),
        makeFact({ content: 'Bob likes dogs', entity_ids: [ENTITY_B] }),
      ]);

      const conflicts = await new ConflictDetector(store, index).detectConflicts();

      expect(conflicts).toHaveLength(0);
    });

    it('excludes already-invalidated facts', async () => {
      await seed([
        makeFact({ content: 'Alice works at Acme', entity_ids: [ENTITY_A], invalidated_by: crypto.randomUUID() }),
        makeFact({ content: 'Alice not works at Acme', entity_ids: [ENTITY_A] }),
      ]);

      const conflicts = await new ConflictDetector(store, index).detectConflicts();

      expect(conflicts).toHaveLength(0);
    });

    it('detects a negation and a supersession in a single pass', async () => {
      const entityC = crypto.randomUUID();
      await seed([
        makeFact({ content: 'Alice works at Acme', entity_ids: [ENTITY_A] }),
        makeFact({ content: 'Alice not works at Acme', entity_ids: [ENTITY_A] }),
        makeFact({ content: 'Bob lives in Paris city center', entity_ids: [entityC], valid_from: OLD }),
        makeFact({ content: 'Bob lives in London city center', entity_ids: [entityC], valid_from: NEW }),
      ]);

      const conflicts = await new ConflictDetector(store, index).detectConflicts();

      expect(conflicts.filter((c) => c.type === 'negation')).toHaveLength(1);
      expect(conflicts.filter((c) => c.type === 'supersession')).toHaveLength(1);
    });

    it('detects conflicts spanning batch-load page boundaries', async () => {
      const entityId = crypto.randomUUID();
      await seed([
        makeFact({ content: 'Unrelated filler fact one' }),
        makeFact({ content: 'Unrelated filler fact two' }),
        makeFact({ content: 'Unrelated filler fact three' }),
        makeFact({ content: 'Alice is on the platform team', entity_ids: [entityId], valid_from: OLD }),
        makeFact({ content: 'Alice is not on the platform team', entity_ids: [entityId], valid_from: NEW }),
      ]);

      const conflicts = await new ConflictDetector(store, index, { batchSize: 2 }).detectConflicts();

      expect(conflicts.filter((c) => c.type === 'negation')).toHaveLength(1);
    });
  });

  describe('resolveConflict', () => {
    let factA: SemanticFact;
    let factB: SemanticFact;

    beforeEach(async () => {
      factA = makeFact({ content: 'A', entity_ids: [ENTITY_A] });
      factB = makeFact({ content: 'B', entity_ids: [ENTITY_A] });
      await store.putFact(factA);
      await store.putFact(factB);
    });

    it('invalidates factB when resolving with keep_a', async () => {
      await new ConflictDetector(store, index).resolveConflict(
        { factA, factB, type: 'negation', confidence: 0.8 },
        'keep_a',
      );

      expect((await store.getFact(factB.id))?.invalidated_by).toBe(factA.id);
      expect((await store.getFact(factA.id))?.invalidated_by).toBeUndefined();
    });

    it('invalidates factA when resolving with keep_b', async () => {
      await new ConflictDetector(store, index).resolveConflict(
        { factA, factB, type: 'negation', confidence: 0.8 },
        'keep_b',
      );

      expect((await store.getFact(factA.id))?.invalidated_by).toBe(factB.id);
      expect((await store.getFact(factB.id))?.invalidated_by).toBeUndefined();
    });

    it('makes no changes when resolving with keep_both', async () => {
      await new ConflictDetector(store, index).resolveConflict(
        { factA, factB, type: 'negation', confidence: 0.8 },
        'keep_both',
      );

      expect((await store.getFact(factA.id))?.invalidated_by).toBeUndefined();
      expect((await store.getFact(factB.id))?.invalidated_by).toBeUndefined();
    });
  });
});
