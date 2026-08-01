/**
 * The eval-gating retention decision (consolidation/retention-gate).
 * `evaluateRetention` promotes candidate lessons whose lift is confirmed
 * and evicts the ones that hurt or never help, under either the
 * point-estimate `margin` rule or the default Welch `inference` rule.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryMemoryStore } from '../src/store/in-memory-store.js';
import { InMemoryOutcomeLedger } from '../src/consolidation/outcome-ledger.js';
import { evaluateRetention } from '../src/consolidation/retention-gate.js';
import type {
  OutcomeLedger,
  FactStats,
  OutcomeBaseline,
} from '../src/consolidation/outcome-ledger.js';
import type { SemanticFact } from '../src/schemas/semantic.js';
import { makeFact, makeProvenance } from './helpers.js';

function makeLesson(id: string, overrides: Partial<SemanticFact> = {}): SemanticFact {
  return makeFact({
    id,
    content: `Lesson ${id}`,
    provenance: makeProvenance({ source: 'system' }),
    tags: ['lesson', 'candidate'],
    ...overrides,
  });
}

/** Record `count` runs containing `factIds`, each scoring `score`. */
async function recordRuns(
  ledger: InMemoryOutcomeLedger,
  prefix: string,
  count: number,
  score: number,
  factIds: string[],
): Promise<void> {
  for (let i = 0; i < count; i++) {
    await ledger.recordOutcome({ run_id: `${prefix}-${i}`, score, fact_ids: factIds });
  }
}

describe('evaluateRetention', () => {
  let store: InMemoryMemoryStore;
  let ledger: InMemoryOutcomeLedger;
  const FACT_ID_A = crypto.randomUUID();
  const FACT_ID_B = crypto.randomUUID();

  beforeEach(() => {
    store = new InMemoryMemoryStore();
    ledger = new InMemoryOutcomeLedger();
  });

  describe('candidate selection', () => {
    it('holds candidates below minTrials', async () => {
      await store.putFact(makeLesson(FACT_ID_A));
      await recordRuns(ledger, 'with', 2, 0.9, [FACT_ID_A]);
      await recordRuns(ledger, 'without', 2, 0.1, []);

      const report = await evaluateRetention(store, ledger, { minTrials: 3 });

      expect(report.held).toEqual([{ factId: FACT_ID_A, trials: 2 }]);
      expect((await store.getFact(FACT_ID_A))?.tags).toContain('candidate');
    });

    it('holds candidates that have never been retrieved (zero trials)', async () => {
      await store.putFact(makeLesson(FACT_ID_A));
      await recordRuns(ledger, 'without', 5, 0.5, []);

      const report = await evaluateRetention(store, ledger);

      expect(report.held).toEqual([{ factId: FACT_ID_A, trials: 0 }]);
    });

    it('ignores non-candidate facts entirely', async () => {
      await store.putFact(makeLesson(FACT_ID_A, { tags: ['lesson', 'verified'] }));
      await recordRuns(ledger, 'with', 5, 0.1, [FACT_ID_A]);
      await recordRuns(ledger, 'without', 5, 0.9, []);

      const report = await evaluateRetention(store, ledger);

      expect(report).toEqual({ promoted: [], evicted: [], held: [] });
      expect((await store.getFact(FACT_ID_A))?.invalidated_by).toBeUndefined();
    });

    it('respects custom candidate and verified tag names', async () => {
      await store.putFact(makeLesson(FACT_ID_A, { tags: ['lesson', 'on-trial'] }));
      await recordRuns(ledger, 'with', 3, 0.9, [FACT_ID_A]);
      await recordRuns(ledger, 'without', 3, 0.5, []);

      const report = await evaluateRetention(store, ledger, {
        decisionRule: 'margin',
        candidateTag: 'on-trial',
        verifiedTag: 'proven',
      });

      expect(report.promoted).toEqual([{ factId: FACT_ID_A }]);
      expect((await store.getFact(FACT_ID_A))?.tags).toEqual(['lesson', 'proven']);
    });

    it('pages through more candidates than one batch holds', async () => {
      const ids = Array.from({ length: 1001 }, () => crypto.randomUUID());
      for (const id of ids) {
        await store.putFact(makeLesson(id));
      }

      const report = await evaluateRetention(store, ledger);

      expect(report.held).toHaveLength(1001);
      expect(report.promoted).toEqual([]);
      expect(report.evicted).toEqual([]);
    });
  });

  describe('margin rule', () => {
    it('promotes a candidate whose lift clears the margin at minTrials', async () => {
      await store.putFact(makeLesson(FACT_ID_A));
      await recordRuns(ledger, 'with', 3, 0.9, [FACT_ID_A]);
      await recordRuns(ledger, 'without', 3, 0.5, []);

      const report = await evaluateRetention(store, ledger, {
        decisionRule: 'margin', minTrials: 3, promoteMargin: 0.05,
      });

      expect(report.promoted).toEqual([{ factId: FACT_ID_A }]);
      expect(report.evicted).toEqual([]);
      const fact = await store.getFact(FACT_ID_A);
      expect(fact?.tags).toContain('verified');
      expect(fact?.tags).not.toContain('candidate');
      expect(fact?.tags).toContain('lesson');
    });

    it('does not duplicate an already-present verified tag on promotion', async () => {
      await store.putFact(makeLesson(FACT_ID_A, { tags: ['lesson', 'candidate', 'verified'] }));
      await recordRuns(ledger, 'with', 3, 0.9, [FACT_ID_A]);
      await recordRuns(ledger, 'without', 3, 0.5, []);

      const report = await evaluateRetention(store, ledger, { decisionRule: 'margin', minTrials: 3, promoteMargin: 0.05 });

      expect(report.promoted).toEqual([{ factId: FACT_ID_A }]);
      const fact = await store.getFact(FACT_ID_A);
      expect(fact?.tags.filter((t) => t === 'verified')).toHaveLength(1);
      expect(fact?.tags).not.toContain('candidate');
    });

    it('evicts a harmful candidate as eval-gate:harmful', async () => {
      await store.putFact(makeLesson(FACT_ID_A));
      await recordRuns(ledger, 'with', 3, 0.2, [FACT_ID_A]);
      await recordRuns(ledger, 'without', 3, 0.8, []);

      const report = await evaluateRetention(store, ledger, { decisionRule: 'margin', minTrials: 3, evictMargin: 0.05 });

      expect(report.evicted).toEqual([{ factId: FACT_ID_A, reason: 'eval-gate:harmful' }]);
      expect((await store.getFact(FACT_ID_A))?.invalidated_by).toBe('eval-gate:harmful');
      expect(await store.findFacts({ tags: ['candidate'], includeInvalidated: false })).toEqual([]);
    });

    it('holds rather than judging against an empty baseline', async () => {
      await store.putFact(makeLesson(FACT_ID_A));
      await recordRuns(ledger, 'with', 4, 0.9, [FACT_ID_A]);

      const report = await evaluateRetention(store, ledger, { decisionRule: 'margin', minTrials: 3 });

      expect(report.held).toEqual([{ factId: FACT_ID_A, trials: 4 }]);
    });

    it('retires an empty-baseline candidate once maxTrials is reached', async () => {
      await store.putFact(makeLesson(FACT_ID_A));
      await recordRuns(ledger, 'with', 3, 0.9, [FACT_ID_A]);

      const report = await evaluateRetention(store, ledger, { decisionRule: 'margin', minTrials: 3, maxTrials: 3 });

      expect(report.evicted).toEqual([{ factId: FACT_ID_A, reason: 'eval-gate:no_lift' }]);
      expect((await store.getFact(FACT_ID_A))?.invalidated_by).toBe('eval-gate:no_lift');
    });

    it('evicts a no-lift candidate once maxTrials is reached', async () => {
      await store.putFact(makeLesson(FACT_ID_A));
      await recordRuns(ledger, 'with', 6, 0.5, [FACT_ID_A]);
      await recordRuns(ledger, 'without', 6, 0.5, []);

      const report = await evaluateRetention(store, ledger, {
        decisionRule: 'margin', minTrials: 3, maxTrials: 5, promoteMargin: 0.05, evictMargin: 0.05,
      });

      expect(report.evicted).toEqual([{ factId: FACT_ID_A, reason: 'eval-gate:no_lift' }]);
      expect((await store.getFact(FACT_ID_A))?.invalidated_by).toBe('eval-gate:no_lift');
    });

    it('keeps a no-lift candidate on trial when maxTrials is unset', async () => {
      await store.putFact(makeLesson(FACT_ID_A));
      await recordRuns(ledger, 'with', 10, 0.5, [FACT_ID_A]);
      await recordRuns(ledger, 'without', 10, 0.5, []);

      const report = await evaluateRetention(store, ledger, { decisionRule: 'margin', minTrials: 3 });

      expect(report.held).toEqual([{ factId: FACT_ID_A, trials: 10 }]);
    });

    it('is idempotent — a second pass after promotion changes nothing', async () => {
      await store.putFact(makeLesson(FACT_ID_A));
      await recordRuns(ledger, 'with', 3, 0.9, [FACT_ID_A]);
      await recordRuns(ledger, 'without', 3, 0.5, []);

      await evaluateRetention(store, ledger, { decisionRule: 'margin' });
      const second = await evaluateRetention(store, ledger, { decisionRule: 'margin' });

      expect(second).toEqual({ promoted: [], evicted: [], held: [] });
      expect((await store.getFact(FACT_ID_A))?.tags.filter((t) => t === 'verified')).toHaveLength(1);
    });

    it('gates multiple candidates independently in one pass', async () => {
      await store.putFact(makeLesson(FACT_ID_A));
      await store.putFact(makeLesson(FACT_ID_B));
      await recordRuns(ledger, 'a', 3, 0.9, [FACT_ID_A]);
      await recordRuns(ledger, 'b', 3, 0.1, [FACT_ID_B]);
      await recordRuns(ledger, 'neutral', 3, 0.5, []);

      const report = await evaluateRetention(store, ledger, { decisionRule: 'margin', minTrials: 3 });

      expect(report.promoted).toEqual([{ factId: FACT_ID_A }]);
      expect(report.evicted).toEqual([{ factId: FACT_ID_B, reason: 'eval-gate:harmful' }]);
    });
  });

  describe('inference rule', () => {
    it('promotes with strong evidence and populates the evidence object', async () => {
      await store.putFact(makeLesson(FACT_ID_A));
      await recordRuns(ledger, 'with', 5, 0.9, [FACT_ID_A]);
      await recordRuns(ledger, 'without', 5, 0.5, []);

      const report = await evaluateRetention(store, ledger, { minTrials: 3 });

      expect(report.promoted).toHaveLength(1);
      const { factId, evidence } = report.promoted[0];
      expect(factId).toBe(FACT_ID_A);
      expect(evidence!.lift).toBeCloseTo(0.4, 10);
      expect(evidence!.pPromote).toBeGreaterThan(0.99);
      expect(evidence!.pEvict).toBeLessThan(0.01);
      expect(evidence!.trials).toBe(5);
      expect(evidence!.baselineRuns).toBe(5);
      expect((await store.getFact(FACT_ID_A))?.tags).toContain('verified');
    });

    it('evicts with strong negative evidence', async () => {
      await store.putFact(makeLesson(FACT_ID_A));
      await recordRuns(ledger, 'with', 5, 0.2, [FACT_ID_A]);
      await recordRuns(ledger, 'without', 5, 0.8, []);

      const report = await evaluateRetention(store, ledger, { minTrials: 3 });

      expect(report.evicted).toHaveLength(1);
      expect(report.evicted[0].reason).toBe('eval-gate:harmful');
      expect(report.evicted[0].evidence!.pEvict).toBeGreaterThan(0.99);
    });

    it('holds a borderline lift the margin rule would have promoted', async () => {
      const setup = async (s: InMemoryMemoryStore, l: InMemoryOutcomeLedger, id: string) => {
        await s.putFact(makeLesson(id));
        await l.recordOutcome({ run_id: 'w1', score: 0.55, fact_ids: [id] });
        await l.recordOutcome({ run_id: 'w2', score: 0.58, fact_ids: [id] });
        await l.recordOutcome({ run_id: 'w3', score: 0.61, fact_ids: [id] });
        await l.recordOutcome({ run_id: 'b1', score: 0.48, fact_ids: [] });
        await l.recordOutcome({ run_id: 'b2', score: 0.50, fact_ids: [] });
        await l.recordOutcome({ run_id: 'b3', score: 0.52, fact_ids: [] });
      };

      const idMargin = crypto.randomUUID();
      const storeMargin = new InMemoryMemoryStore();
      const ledgerMargin = new InMemoryOutcomeLedger();
      await setup(storeMargin, ledgerMargin, idMargin);
      const marginReport = await evaluateRetention(storeMargin, ledgerMargin, {
        decisionRule: 'margin', minTrials: 3,
      });

      await setup(store, ledger, FACT_ID_A);
      const inferenceReport = await evaluateRetention(store, ledger, { minTrials: 3 });

      expect(marginReport.promoted).toEqual([{ factId: idMargin }]);
      expect(inferenceReport.promoted).toEqual([]);
      expect(inferenceReport.held).toHaveLength(1);
      expect(inferenceReport.held[0].evidence!.pPromote).toBeLessThan(0.9);
    });

    it('holds identical means regardless of trials when maxTrials is unset', async () => {
      await store.putFact(makeLesson(FACT_ID_A));
      await recordRuns(ledger, 'with', 20, 0.5, [FACT_ID_A]);
      await recordRuns(ledger, 'without', 20, 0.5, []);

      const report = await evaluateRetention(store, ledger, { minTrials: 3 });

      expect(report.held).toHaveLength(1);
      expect(report.held[0].evidence!.pPromote).toBeLessThan(0.5);
      expect(report.held[0].evidence!.pEvict).toBeLessThan(0.5);
    });

    it('holds when the baseline has fewer than 2 runs', async () => {
      await store.putFact(makeLesson(FACT_ID_A));
      await recordRuns(ledger, 'with', 4, 0.9, [FACT_ID_A]);
      await ledger.recordOutcome({ run_id: 'solo-baseline', score: 0.2, fact_ids: [] });

      const report = await evaluateRetention(store, ledger, { minTrials: 3 });

      expect(report.held).toEqual([{ factId: FACT_ID_A, trials: 4 }]);
    });

    it('falls back to the noise floor when the ledger omits variance', async () => {
      await store.putFact(makeLesson(FACT_ID_A));
      const noVarLedger: OutcomeLedger = {
        async recordOutcome() {},
        async getFactStats(): Promise<FactStats> {
          return { factId: FACT_ID_A, trials: 5, meanScore: 0.9 };
        },
        async listFactStats() {
          return [];
        },
        async getBaseline(): Promise<OutcomeBaseline> {
          return { runs: 5, meanScore: 0.5 };
        },
        async clear() {},
      };

      const report = await evaluateRetention(store, noVarLedger, { minTrials: 3, noiseFloorSd: 0.1 });

      expect(report.promoted).toHaveLength(1);
      expect(report.promoted[0].evidence!.se).toBeCloseTo(Math.sqrt(0.01 / 5 + 0.01 / 5), 10);
    });

    it('suppresses a borderline promotion under BH that the per-candidate rule allows', async () => {
      const seed = async (s: InMemoryMemoryStore, l: InMemoryOutcomeLedger) => {
        const a = 'aaaaaaaa-0000-4000-8000-000000000001';
        const b = 'bbbbbbbb-0000-4000-8000-000000000002';
        await s.putFact(makeLesson(a));
        await s.putFact(makeLesson(b));
        for (let i = 0; i < 4; i++) await l.recordOutcome({ run_id: `a-${i}`, score: 0.65, fact_ids: [a] });
        for (let i = 0; i < 4; i++) await l.recordOutcome({ run_id: `b-${i}`, score: 0.5, fact_ids: [b] });
        for (let i = 0; i < 4; i++) await l.recordOutcome({ run_id: `e-${i}`, score: 0.5, fact_ids: [] });
        return { a, b };
      };

      const storeNone = new InMemoryMemoryStore();
      const ledgerNone = new InMemoryOutcomeLedger();
      const { a: aNone } = await seed(storeNone, ledgerNone);
      const none = await evaluateRetention(storeNone, ledgerNone, {
        minTrials: 3, multipleComparison: 'none', sequentialControl: 'none',
      });

      const storeBh = new InMemoryMemoryStore();
      const ledgerBh = new InMemoryOutcomeLedger();
      await seed(storeBh, ledgerBh);
      const bh = await evaluateRetention(storeBh, ledgerBh, {
        minTrials: 3, multipleComparison: 'bh', sequentialControl: 'none',
      });

      expect(none.promoted.map((p) => p.factId)).toEqual([aNone]);
      expect(bh.promoted).toEqual([]);
    });

    it('applies the maxTrials escape hatch to undecidable candidates', async () => {
      await store.putFact(makeLesson(FACT_ID_A));
      await recordRuns(ledger, 'with', 8, 0.52, [FACT_ID_A]);
      await recordRuns(ledger, 'without', 8, 0.5, []);

      const report = await evaluateRetention(store, ledger, { minTrials: 3, maxTrials: 6 });

      expect(report.evicted).toEqual([
        {
          factId: FACT_ID_A,
          reason: 'eval-gate:no_lift',
          evidence: expect.objectContaining({ trials: 8 }),
        },
      ]);
    });

    it('holds defensively when both promote and evict thresholds trip', async () => {
      await store.putFact(makeLesson(FACT_ID_A));
      await recordRuns(ledger, 'with', 3, 0.5, [FACT_ID_A]);
      await recordRuns(ledger, 'without', 3, 0.5, []);

      const report = await evaluateRetention(store, ledger, {
        minTrials: 3,
        promoteMargin: 0,
        evictMargin: 0,
        promoteConfidence: 0.5,
        evictConfidence: 0.5,
        sequentialControl: 'none',
        multipleComparison: 'none',
      });

      expect(report.promoted).toEqual([]);
      expect(report.evicted).toEqual([]);
      expect(report.held).toHaveLength(1);
      expect(report.held[0].factId).toBe(FACT_ID_A);
      expect(report.held[0].evidence).toBeDefined();
      expect((await store.getFact(FACT_ID_A))?.tags).toContain('candidate');
    });
  });
});
