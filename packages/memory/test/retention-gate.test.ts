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

  it('promotes a candidate whose lift clears the margin at min_trials', async () => {
    await store.putFact(makeLesson(FACT_ID_A));
    await recordRuns(ledger, 'with', 3, 0.9, [FACT_ID_A]);
    await recordRuns(ledger, 'without', 3, 0.5, []);

    const report = await evaluateRetention(store, ledger, { min_trials: 3, promote_margin: 0.05 });

    expect(report.promoted).toEqual([FACT_ID_A]);
    expect(report.evicted).toEqual([]);
    const fact = await store.getFact(FACT_ID_A);
    expect(fact?.tags).toContain('verified');
    expect(fact?.tags).not.toContain('candidate');
    expect(fact?.tags).toContain('lesson'); // scope tags preserved
  });

  it('evicts a harmful candidate with invalidated_by eval-gate:harmful', async () => {
    await store.putFact(makeLesson(FACT_ID_A));
    await recordRuns(ledger, 'with', 3, 0.2, [FACT_ID_A]);
    await recordRuns(ledger, 'without', 3, 0.8, []);

    const report = await evaluateRetention(store, ledger, { min_trials: 3, evict_margin: 0.05 });

    expect(report.evicted).toEqual([{ fact_id: FACT_ID_A, reason: 'eval-gate:harmful' }]);
    const fact = await store.getFact(FACT_ID_A);
    expect(fact?.invalidated_by).toBe('eval-gate:harmful');

    // Evicted facts are excluded from default listings.
    const active = await store.findFacts({ tags: ['candidate'], include_invalidated: false });
    expect(active).toEqual([]);
  });

  it('holds candidates with insufficient trials', async () => {
    await store.putFact(makeLesson(FACT_ID_A));
    await recordRuns(ledger, 'with', 2, 0.9, [FACT_ID_A]);
    await recordRuns(ledger, 'without', 2, 0.1, []);

    const report = await evaluateRetention(store, ledger, { min_trials: 3 });

    expect(report.held).toEqual([{ fact_id: FACT_ID_A, trials: 2 }]);
    expect((await store.getFact(FACT_ID_A))?.tags).toContain('candidate');
  });

  it('holds candidates that have never been retrieved (zero trials)', async () => {
    await store.putFact(makeLesson(FACT_ID_A));
    await recordRuns(ledger, 'without', 5, 0.5, []);

    const report = await evaluateRetention(store, ledger);
    expect(report.held).toEqual([{ fact_id: FACT_ID_A, trials: 0 }]);
  });

  it('holds rather than judging against an empty baseline', async () => {
    await store.putFact(makeLesson(FACT_ID_A));
    // Every recorded run contains the fact — leave-one-out baseline is empty.
    await recordRuns(ledger, 'with', 4, 0.9, [FACT_ID_A]);

    const report = await evaluateRetention(store, ledger, { min_trials: 3 });
    expect(report.held).toEqual([{ fact_id: FACT_ID_A, trials: 4 }]);
  });

  it('breaks the empty-baseline deadlock via max_trials', async () => {
    await store.putFact(makeLesson(FACT_ID_A));
    // Fact in every recorded run → no baseline can ever form; max_trials
    // must still retire it or it starves the trial queue forever.
    await recordRuns(ledger, 'with', 6, 0.9, [FACT_ID_A]);

    const report = await evaluateRetention(store, ledger, { min_trials: 3, max_trials: 5 });
    expect(report.evicted).toEqual([{ fact_id: FACT_ID_A, reason: 'eval-gate:no_lift' }]);
  });

  it('evicts no-lift candidates once max_trials is reached', async () => {
    await store.putFact(makeLesson(FACT_ID_A));
    await recordRuns(ledger, 'with', 6, 0.5, [FACT_ID_A]);
    await recordRuns(ledger, 'without', 6, 0.5, []);

    const report = await evaluateRetention(store, ledger, {
      min_trials: 3,
      max_trials: 5,
      promote_margin: 0.05,
      evict_margin: 0.05,
    });

    expect(report.evicted).toEqual([{ fact_id: FACT_ID_A, reason: 'eval-gate:no_lift' }]);
    expect((await store.getFact(FACT_ID_A))?.invalidated_by).toBe('eval-gate:no_lift');
  });

  it('keeps no-lift candidates on trial when max_trials is unset', async () => {
    await store.putFact(makeLesson(FACT_ID_A));
    await recordRuns(ledger, 'with', 10, 0.5, [FACT_ID_A]);
    await recordRuns(ledger, 'without', 10, 0.5, []);

    const report = await evaluateRetention(store, ledger, { min_trials: 3 });
    expect(report.held).toEqual([{ fact_id: FACT_ID_A, trials: 10 }]);
  });

  it('is idempotent — a second pass after promotion changes nothing', async () => {
    await store.putFact(makeLesson(FACT_ID_A));
    await recordRuns(ledger, 'with', 3, 0.9, [FACT_ID_A]);
    await recordRuns(ledger, 'without', 3, 0.5, []);

    await evaluateRetention(store, ledger);
    const second = await evaluateRetention(store, ledger);

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

    const report = await evaluateRetention(store, ledger, { min_trials: 3 });

    expect(report.promoted).toEqual([FACT_ID_A]);
    expect(report.evicted).toEqual([{ fact_id: FACT_ID_B, reason: 'eval-gate:harmful' }]);
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
      candidate_tag: 'on-trial',
      verified_tag: 'proven',
    });

    expect(report.promoted).toEqual([FACT_ID_A]);
    const fact = await store.getFact(FACT_ID_A);
    expect(fact?.tags).toEqual(['lesson', 'proven']);
  });
});
