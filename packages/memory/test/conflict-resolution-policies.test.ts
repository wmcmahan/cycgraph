/**
 * Tests for ConflictDetector.autoResolveAll: the supersede-on-newer,
 * negation-invalidates-positive, and manual-review resolution policies.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryMemoryStore } from '../src/store/in-memory-store.js';
import { InMemoryMemoryIndex } from '../src/search/in-memory-index.js';
import { ConflictDetector } from '../src/consolidation/conflict-detector.js';
import type { SemanticFact } from '../src/schemas/semantic.js';
import { makeFact } from './helpers.js';

const ENTITY_A = crypto.randomUUID();

const OLD = new Date('2024-01-01T00:00:00.000Z');
const NEW = new Date('2024-03-01T00:00:00.000Z');
const SAME_TIME = new Date('2024-02-01T00:00:00.000Z');

const ID_SMALL = '00000000-0000-0000-0000-000000000001';
const ID_LARGE = '00000000-0000-0000-0000-000000000002';

describe('ConflictDetector.autoResolveAll', () => {
  let store: InMemoryMemoryStore;
  let index: InMemoryMemoryIndex;

  beforeEach(() => {
    store = new InMemoryMemoryStore();
    index = new InMemoryMemoryIndex();
  });

  async function put(...facts: SemanticFact[]): Promise<void> {
    for (const fact of facts) await store.putFact(fact);
  }

  describe('supersede-on-newer', () => {
    it('invalidates the older fact in a negation conflict', async () => {
      const older = makeFact({ content: 'Alice works at Acme', entity_ids: [ENTITY_A], valid_from: OLD });
      const newer = makeFact({ content: 'Alice no longer works at Acme', entity_ids: [ENTITY_A], valid_from: NEW });
      await put(older, newer);

      const report = await new ConflictDetector(store, index).autoResolveAll(
        [{ factA: older, factB: newer, type: 'negation', confidence: 0.8 }],
        'supersede-on-newer',
      );

      expect(report.resolved).toBe(1);
      expect((await store.getFact(older.id))?.invalidated_by).toBe(newer.id);
    });

    it('invalidates the older fact in a supersession conflict', async () => {
      const older = makeFact({ content: 'Alice works at Acme Corp', entity_ids: [ENTITY_A], valid_from: OLD });
      const newer = makeFact({ content: 'Alice works at Beta Corp', entity_ids: [ENTITY_A], valid_from: NEW });
      await put(older, newer);

      const report = await new ConflictDetector(store, index).autoResolveAll(
        [{ factA: older, factB: newer, type: 'supersession', confidence: 0.9 }],
        'supersede-on-newer',
      );

      expect(report.resolved).toBe(1);
      expect((await store.getFact(older.id))?.invalidated_by).toBe(newer.id);
    });

    it('invalidates the older fact in a semantic contradiction', async () => {
      const older = makeFact({ content: 'Alice is the CEO', entity_ids: [ENTITY_A], valid_from: OLD });
      const newer = makeFact({ content: 'Junior intern position held', entity_ids: [ENTITY_A], valid_from: NEW });
      await put(older, newer);

      const report = await new ConflictDetector(store, index).autoResolveAll(
        [{ factA: older, factB: newer, type: 'semantic_contradiction', confidence: 0.6 }],
        'supersede-on-newer',
      );

      expect(report.resolved).toBe(1);
      expect((await store.getFact(older.id))?.invalidated_by).toBe(newer.id);
    });

    it('keeps factA when factA is the newer fact', async () => {
      const newer = makeFact({ content: 'Alice works at Beta Corp', entity_ids: [ENTITY_A], valid_from: NEW });
      const older = makeFact({ content: 'Alice works at Acme Corp', entity_ids: [ENTITY_A], valid_from: OLD });
      await put(newer, older);

      const report = await new ConflictDetector(store, index).autoResolveAll(
        [{ factA: newer, factB: older, type: 'supersession', confidence: 0.9 }],
        'supersede-on-newer',
      );

      expect(report.resolved).toBe(1);
      expect((await store.getFact(older.id))?.invalidated_by).toBe(newer.id);
      expect((await store.getFact(newer.id))?.invalidated_by).toBeUndefined();
    });

    it('keeps the lexicographically smaller id when timestamps tie and factA is smaller', async () => {
      const factA = makeFact({ id: ID_SMALL, content: 'Fact one', entity_ids: [ENTITY_A], valid_from: SAME_TIME });
      const factB = makeFact({ id: ID_LARGE, content: 'Fact two', entity_ids: [ENTITY_A], valid_from: SAME_TIME });
      await put(factA, factB);

      const report = await new ConflictDetector(store, index).autoResolveAll(
        [{ factA, factB, type: 'supersession', confidence: 0.9 }],
        'supersede-on-newer',
      );

      expect(report.details[0].action).toContain('lexicographically smaller ID');
      expect((await store.getFact(factA.id))?.invalidated_by).toBeUndefined();
      expect((await store.getFact(factB.id))?.invalidated_by).toBe(factA.id);
    });

    it('keeps the lexicographically smaller id when timestamps tie and factB is smaller', async () => {
      const factA = makeFact({ id: ID_LARGE, content: 'Fact one', entity_ids: [ENTITY_A], valid_from: SAME_TIME });
      const factB = makeFact({ id: ID_SMALL, content: 'Fact two', entity_ids: [ENTITY_A], valid_from: SAME_TIME });
      await put(factA, factB);

      const report = await new ConflictDetector(store, index).autoResolveAll(
        [{ factA, factB, type: 'supersession', confidence: 0.9 }],
        'supersede-on-newer',
      );

      expect(report.details[0].action).toContain('lexicographically smaller ID');
      expect((await store.getFact(factB.id))?.invalidated_by).toBeUndefined();
      expect((await store.getFact(factA.id))?.invalidated_by).toBe(factB.id);
    });
  });

  describe('negation-invalidates-positive', () => {
    it('keeps the newer negation and invalidates the older positive', async () => {
      const positive = makeFact({ content: 'Alice works at Acme', entity_ids: [ENTITY_A], valid_from: OLD });
      const negative = makeFact({ content: 'Alice no longer works at Acme', entity_ids: [ENTITY_A], valid_from: NEW });
      await put(positive, negative);

      const report = await new ConflictDetector(store, index).autoResolveAll(
        [{ factA: positive, factB: negative, type: 'negation', confidence: 0.8 }],
        'negation-invalidates-positive',
      );

      expect(report.resolved).toBe(1);
      expect((await store.getFact(positive.id))?.invalidated_by).toBe(negative.id);
      expect((await store.getFact(negative.id))?.invalidated_by).toBeUndefined();
    });

    it('lets a newer positive correction beat a stale negation', async () => {
      const staleNegation = makeFact({ content: 'Endpoint is not safe to call', entity_ids: [ENTITY_A], valid_from: OLD });
      const newerPositive = makeFact({ content: 'Endpoint is safe to call', entity_ids: [ENTITY_A], valid_from: NEW });
      await put(staleNegation, newerPositive);

      const report = await new ConflictDetector(store, index).autoResolveAll(
        [{ factA: staleNegation, factB: newerPositive, type: 'negation', confidence: 0.8 }],
        'negation-invalidates-positive',
      );

      expect(report.resolved).toBe(1);
      expect((await store.getFact(newerPositive.id))?.invalidated_by).toBeUndefined();
      expect((await store.getFact(staleNegation.id))?.invalidated_by).toBe(newerPositive.id);
    });

    it('keeps factA when factA is the newer fact', async () => {
      const newerPositive = makeFact({ content: 'Alice works at Acme', entity_ids: [ENTITY_A], valid_from: NEW });
      const olderNegation = makeFact({ content: 'Alice no longer works at Acme', entity_ids: [ENTITY_A], valid_from: OLD });
      await put(newerPositive, olderNegation);

      const report = await new ConflictDetector(store, index).autoResolveAll(
        [{ factA: newerPositive, factB: olderNegation, type: 'negation', confidence: 0.8 }],
        'negation-invalidates-positive',
      );

      expect(report.details[0].action).toContain('newer fact kept');
      expect((await store.getFact(newerPositive.id))?.invalidated_by).toBeUndefined();
      expect((await store.getFact(olderNegation.id))?.invalidated_by).toBe(newerPositive.id);
    });

    it('keeps the negation on a timestamp tie when factA carries the negation', async () => {
      const negation = makeFact({ content: 'Alice no longer works at Acme', entity_ids: [ENTITY_A], valid_from: SAME_TIME });
      const positive = makeFact({ content: 'Alice works at Acme', entity_ids: [ENTITY_A], valid_from: SAME_TIME });
      await put(negation, positive);

      const report = await new ConflictDetector(store, index).autoResolveAll(
        [{ factA: negation, factB: positive, type: 'negation', confidence: 0.8 }],
        'negation-invalidates-positive',
      );

      expect(report.details[0].action).toContain('negation kept');
      expect((await store.getFact(negation.id))?.invalidated_by).toBeUndefined();
      expect((await store.getFact(positive.id))?.invalidated_by).toBe(negation.id);
    });

    it('keeps the negation on a timestamp tie when factB carries the negation', async () => {
      const positive = makeFact({ content: 'Alice works at Acme', entity_ids: [ENTITY_A], valid_from: SAME_TIME });
      const negation = makeFact({ content: 'Alice no longer works at Acme', entity_ids: [ENTITY_A], valid_from: SAME_TIME });
      await put(positive, negation);

      const report = await new ConflictDetector(store, index).autoResolveAll(
        [{ factA: positive, factB: negation, type: 'negation', confidence: 0.8 }],
        'negation-invalidates-positive',
      );

      expect(report.details[0].action).toContain('negation kept');
      expect((await store.getFact(negation.id))?.invalidated_by).toBeUndefined();
      expect((await store.getFact(positive.id))?.invalidated_by).toBe(negation.id);
    });

    it('uses temporal order for a supersession conflict', async () => {
      const older = makeFact({ content: 'Alice works at Acme Corp', entity_ids: [ENTITY_A], valid_from: OLD });
      const newer = makeFact({ content: 'Alice works at Beta Corp', entity_ids: [ENTITY_A], valid_from: NEW });
      await put(older, newer);

      const report = await new ConflictDetector(store, index).autoResolveAll(
        [{ factA: older, factB: newer, type: 'supersession', confidence: 0.9 }],
        'negation-invalidates-positive',
      );

      expect(report.resolved).toBe(1);
      expect((await store.getFact(older.id))?.invalidated_by).toBe(newer.id);
    });

    it('skips semantic contradictions as manual review', async () => {
      const f1 = makeFact({ content: 'Alice is the CEO', entity_ids: [ENTITY_A] });
      const f2 = makeFact({ content: 'Junior intern position held', entity_ids: [ENTITY_A] });
      await put(f1, f2);

      const report = await new ConflictDetector(store, index).autoResolveAll(
        [{ factA: f1, factB: f2, type: 'semantic_contradiction', confidence: 0.6 }],
        'negation-invalidates-positive',
      );

      expect(report.skipped).toBe(1);
      expect(report.resolved).toBe(0);
      expect(report.details[0].action).toBe('requires manual review');
    });
  });

  describe('policy selection and reporting', () => {
    it('skips every conflict under manual-review', async () => {
      const f1 = makeFact({ content: 'Alice works at Acme', entity_ids: [ENTITY_A], valid_from: OLD });
      const f2 = makeFact({ content: 'Alice no longer works at Acme', entity_ids: [ENTITY_A], valid_from: NEW });
      await put(f1, f2);

      const report = await new ConflictDetector(store, index).autoResolveAll(
        [
          { factA: f1, factB: f2, type: 'negation', confidence: 0.8 },
          { factA: f1, factB: f2, type: 'supersession', confidence: 0.9 },
        ],
        'manual-review',
      );

      expect(report.skipped).toBe(2);
      expect(report.resolved).toBe(0);
    });

    it('defaults to manual-review when no policy is configured or passed', async () => {
      const f1 = makeFact({ content: 'Alice works at Acme', entity_ids: [ENTITY_A], valid_from: OLD });
      const f2 = makeFact({ content: 'Alice no longer works at Acme', entity_ids: [ENTITY_A], valid_from: NEW });
      await put(f1, f2);

      const report = await new ConflictDetector(store, index).autoResolveAll(
        [{ factA: f1, factB: f2, type: 'negation', confidence: 0.8 }],
      );

      expect(report.skipped).toBe(1);
      expect(report.resolved).toBe(0);
      expect(report.details[0].action).toContain('manual review');
    });

    it('falls back to the policy from constructor options', async () => {
      const older = makeFact({ content: 'A works at Acme', entity_ids: [ENTITY_A], valid_from: OLD });
      const newer = makeFact({ content: 'A works at Beta', entity_ids: [ENTITY_A], valid_from: NEW });
      await put(older, newer);

      const report = await new ConflictDetector(store, index, { policy: 'supersede-on-newer' }).autoResolveAll(
        [{ factA: older, factB: newer, type: 'supersession', confidence: 0.9 }],
      );

      expect(report.resolved).toBe(1);
      expect((await store.getFact(older.id))?.invalidated_by).toBe(newer.id);
    });

    it('reports resolved and skipped counts for a mix of conflicts', async () => {
      const f1 = makeFact({ content: 'A works here', entity_ids: [ENTITY_A], valid_from: OLD });
      const f2 = makeFact({ content: 'A no longer works here', entity_ids: [ENTITY_A], valid_from: NEW });
      const f3 = makeFact({ content: 'A is CEO', entity_ids: [ENTITY_A] });
      const f4 = makeFact({ content: 'Junior intern', entity_ids: [ENTITY_A] });
      await put(f1, f2, f3, f4);

      const report = await new ConflictDetector(store, index).autoResolveAll(
        [
          { factA: f1, factB: f2, type: 'negation', confidence: 0.8 },
          { factA: f3, factB: f4, type: 'semantic_contradiction', confidence: 0.6 },
        ],
        'negation-invalidates-positive',
      );

      expect(report.resolved).toBe(1);
      expect(report.skipped).toBe(1);
      expect(report.details).toHaveLength(2);
    });

    it('returns zero counts for an empty conflict list', async () => {
      const report = await new ConflictDetector(store, index).autoResolveAll([], 'supersede-on-newer');

      expect(report.resolved).toBe(0);
      expect(report.skipped).toBe(0);
      expect(report.details).toHaveLength(0);
    });
  });
});
