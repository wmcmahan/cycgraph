import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryMemoryStore } from '../src/store/in-memory-store.js';
import { InMemoryOutcomeLedger } from '../src/consolidation/outcome-ledger.js';
import { evaluateRetention } from '../src/consolidation/retention-gate.js';
import type { SemanticFact } from '../src/schemas/semantic.js';
import type { Provenance } from '../src/schemas/provenance.js';

const prov: Provenance = { source: 'system', created_at: new Date() };

function makeLesson(id: string, overrides: Partial<SemanticFact> = {}): SemanticFact {
  return {
    id,
    content: `Lesson ${id}`,
    source_episode_ids: [],
    entity_ids: [],
    provenance: prov,
    valid_from: new Date(),
    tags: ['lesson', 'candidate'],
    ...overrides,
  };
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

  it('promotes a candidate whose lift clears the margin at minTrials', async () => {
    await store.putFact(makeLesson(FACT_ID_A));
    await recordRuns(ledger, 'with', 3, 0.9, [FACT_ID_A]);
    await recordRuns(ledger, 'without', 3, 0.5, []);

    const report = await evaluateRetention(store, ledger, { decisionRule: 'margin', minTrials: 3, promoteMargin: 0.05 });

    expect(report.promoted).toEqual([{ factId: FACT_ID_A }]);
    expect(report.evicted).toEqual([]);
    const fact = await store.getFact(FACT_ID_A);
    expect(fact?.tags).toContain('verified');
    expect(fact?.tags).not.toContain('candidate');
    expect(fact?.tags).toContain('lesson'); // scope tags preserved
  });

  it('promotion does not duplicate an already-present verified tag', async () => {
    // A fact carrying BOTH status tags (writer bug / manual edit) must come
    // out with exactly one 'verified'.
    await store.putFact(makeLesson(FACT_ID_A, { tags: ['lesson', 'candidate', 'verified'] }));
    await recordRuns(ledger, 'with', 3, 0.9, [FACT_ID_A]);
    await recordRuns(ledger, 'without', 3, 0.5, []);

    const report = await evaluateRetention(store, ledger, { decisionRule: 'margin', minTrials: 3, promoteMargin: 0.05 });

    expect(report.promoted).toEqual([{ factId: FACT_ID_A }]);
    const fact = await store.getFact(FACT_ID_A);
    expect(fact?.tags.filter((t) => t === 'verified')).toHaveLength(1);
    expect(fact?.tags).not.toContain('candidate');
  });

  it('evicts a harmful candidate with invalidated_by eval-gate:harmful', async () => {
    await store.putFact(makeLesson(FACT_ID_A));
    await recordRuns(ledger, 'with', 3, 0.2, [FACT_ID_A]);
    await recordRuns(ledger, 'without', 3, 0.8, []);

    const report = await evaluateRetention(store, ledger, { decisionRule: 'margin', minTrials: 3, evictMargin: 0.05 });

    expect(report.evicted).toEqual([{ factId: FACT_ID_A, reason: 'eval-gate:harmful' }]);
    const fact = await store.getFact(FACT_ID_A);
    expect(fact?.invalidated_by).toBe('eval-gate:harmful');

    // Evicted facts are excluded from default listings.
    const active = await store.findFacts({ tags: ['candidate'], includeInvalidated: false });
    expect(active).toEqual([]);
  });

  it('holds candidates with insufficient trials', async () => {
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

  it('holds rather than judging against an empty baseline', async () => {
    await store.putFact(makeLesson(FACT_ID_A));
    // Every recorded run contains the fact — leave-one-out baseline is empty.
    await recordRuns(ledger, 'with', 4, 0.9, [FACT_ID_A]);

    const report = await evaluateRetention(store, ledger, { minTrials: 3 });
    expect(report.held).toEqual([{ factId: FACT_ID_A, trials: 4 }]);
  });

  it('breaks the empty-baseline deadlock via maxTrials', async () => {
    await store.putFact(makeLesson(FACT_ID_A));
    // Fact in every recorded run → no baseline can ever form; maxTrials
    // must still retire it or it starves the trial queue forever.
    await recordRuns(ledger, 'with', 6, 0.9, [FACT_ID_A]);

    const report = await evaluateRetention(store, ledger, { minTrials: 3, maxTrials: 5 });
    expect(report.evicted).toEqual([{ factId: FACT_ID_A, reason: 'eval-gate:no_lift' }]);
  });

  it('evicts no-lift candidates once maxTrials is reached', async () => {
    await store.putFact(makeLesson(FACT_ID_A));
    await recordRuns(ledger, 'with', 6, 0.5, [FACT_ID_A]);
    await recordRuns(ledger, 'without', 6, 0.5, []);

    const report = await evaluateRetention(store, ledger, {
      decisionRule: 'margin',
      minTrials: 3,
      maxTrials: 5,
      promoteMargin: 0.05,
      evictMargin: 0.05,
    });

    expect(report.evicted).toEqual([{ factId: FACT_ID_A, reason: 'eval-gate:no_lift' }]);
    expect((await store.getFact(FACT_ID_A))?.invalidated_by).toBe('eval-gate:no_lift');
  });

  it('keeps no-lift candidates on trial when maxTrials is unset', async () => {
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
    const fact = await store.getFact(FACT_ID_A);
    expect(fact?.tags.filter((t) => t === 'verified')).toHaveLength(1);
  });

  it('gates multiple candidates independently in one pass', async () => {
    await store.putFact(makeLesson(FACT_ID_A));
    await store.putFact(makeLesson(FACT_ID_B));
    // Runs with A score high, runs with B score low, neutral runs in between.
    await recordRuns(ledger, 'a', 3, 0.9, [FACT_ID_A]);
    await recordRuns(ledger, 'b', 3, 0.1, [FACT_ID_B]);
    await recordRuns(ledger, 'neutral', 3, 0.5, []);

    const report = await evaluateRetention(store, ledger, { decisionRule: 'margin', minTrials: 3 });

    expect(report.promoted).toEqual([{ factId: FACT_ID_A }]);
    expect(report.evicted).toEqual([{ factId: FACT_ID_B, reason: 'eval-gate:harmful' }]);
  });

  it('ignores non-candidate facts entirely', async () => {
    await store.putFact(makeLesson(FACT_ID_A, { tags: ['lesson', 'verified'] }));
    await recordRuns(ledger, 'with', 5, 0.1, [FACT_ID_A]);
    await recordRuns(ledger, 'without', 5, 0.9, []);

    const report = await evaluateRetention(store, ledger);
    expect(report).toEqual({ promoted: [], evicted: [], held: [] });
    expect((await store.getFact(FACT_ID_A))?.invalidated_by).toBeUndefined();
  });

  it('respects custom candidate/verified tag names', async () => {
    await store.putFact(makeLesson(FACT_ID_A, { tags: ['lesson', 'on-trial'] }));
    await recordRuns(ledger, 'with', 3, 0.9, [FACT_ID_A]);
    await recordRuns(ledger, 'without', 3, 0.5, []);

    const report = await evaluateRetention(store, ledger, {
      decisionRule: 'margin',
      candidateTag: 'on-trial',
      verifiedTag: 'proven',
    });

    expect(report.promoted).toEqual([{ factId: FACT_ID_A }]);
    const fact = await store.getFact(FACT_ID_A);
    expect(fact?.tags).toEqual(['lesson', 'proven']);
  });
});

describe('evaluateRetention — inference rule', () => {
  let store: InMemoryMemoryStore;
  let ledger: InMemoryOutcomeLedger;
  const FACT_ID_A = crypto.randomUUID();

  beforeEach(() => {
    store = new InMemoryMemoryStore();
    ledger = new InMemoryOutcomeLedger();
  });

  it('promotes with strong evidence and populates the evidence object', async () => {
    await store.putFact(makeLesson(FACT_ID_A));
    // Big lift, low variance, decent n: 5 runs at 0.9 vs 5 runs at 0.5.
    await recordRuns(ledger, 'with', 5, 0.9, [FACT_ID_A]);
    await recordRuns(ledger, 'without', 5, 0.5, []);

    const report = await evaluateRetention(store, ledger, { minTrials: 3 });

    expect(report.promoted).toHaveLength(1);
    const { factId, evidence } = report.promoted[0];
    expect(factId).toBe(FACT_ID_A);
    expect(evidence).toBeDefined();
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
    // lift = 0.08 ≥ promoteMargin 0.05, but with only 3 noisy trials the
    // evidence is far below 90% confidence. The margin rule acts; the
    // inference rule (correctly) waits.
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
      decisionRule: 'margin',
      minTrials: 3,
    });
    expect(marginReport.promoted).toEqual([{ factId: idMargin }]);

    await setup(store, ledger, FACT_ID_A);
    const inferenceReport = await evaluateRetention(store, ledger, { minTrials: 3 });
    expect(inferenceReport.promoted).toEqual([]);
    expect(inferenceReport.held).toHaveLength(1);
    expect(inferenceReport.held[0].evidence).toBeDefined();
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

  it('BH suppresses a borderline promotion that the per-candidate rule allows', async () => {
    // Candidate A: borderline positive evidence (one-sided p ≈ 0.07).
    // Candidate B: clearly null. Under 'none', A clears the 0.9 bar.
    // Under BH with two tests, A's p must beat (1/2)·0.1 = 0.05 — it
    // doesn't, so the gate holds it.
    const seed = async (s: InMemoryMemoryStore, l: InMemoryOutcomeLedger) => {
      const a = 'aaaaaaaa-0000-4000-8000-000000000001';
      const b = 'bbbbbbbb-0000-4000-8000-000000000002';
      await s.putFact(makeLesson(a));
      await s.putFact(makeLesson(b));
      // A: 4 runs at 0.65; B: 4 runs at 0.50; 4 empty runs at 0.50.
      for (let i = 0; i < 4; i++) await l.recordOutcome({ run_id: `a-${i}`, score: 0.65, fact_ids: [a] });
      for (let i = 0; i < 4; i++) await l.recordOutcome({ run_id: `b-${i}`, score: 0.5, fact_ids: [b] });
      for (let i = 0; i < 4; i++) await l.recordOutcome({ run_id: `e-${i}`, score: 0.5, fact_ids: [] });
      return { a, b };
    };

    const storeNone = new InMemoryMemoryStore();
    const ledgerNone = new InMemoryOutcomeLedger();
    const { a: aNone } = await seed(storeNone, ledgerNone);
    const none = await evaluateRetention(storeNone, ledgerNone, {
      minTrials: 3,
      multipleComparison: 'none',
      sequentialControl: 'none', // isolate BH — spending is tested elsewhere
    });
    expect(none.promoted.map((p) => p.factId)).toEqual([aNone]);

    const storeBh = new InMemoryMemoryStore();
    const ledgerBh = new InMemoryOutcomeLedger();
    await seed(storeBh, ledgerBh);
    const bh = await evaluateRetention(storeBh, ledgerBh, {
      minTrials: 3,
      multipleComparison: 'bh',
      sequentialControl: 'none', // isolate BH — spending is tested elsewhere
    });
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
});
