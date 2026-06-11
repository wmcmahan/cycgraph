import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryOutcomeLedger, RunOutcomeSchema } from '../src/consolidation/outcome-ledger.js';

describe('InMemoryOutcomeLedger', () => {
  let ledger: InMemoryOutcomeLedger;

  beforeEach(() => {
    ledger = new InMemoryOutcomeLedger();
  });

  it('accumulates per-fact trials and mean score', async () => {
    await ledger.recordOutcome({ run_id: 'r1', score: 0.8, fact_ids: ['f1', 'f2'] });
    await ledger.recordOutcome({ run_id: 'r2', score: 0.4, fact_ids: ['f1'] });

    const f1 = await ledger.getFactStats('f1');
    expect(f1).toEqual({ fact_id: 'f1', trials: 2, mean_score: (0.8 + 0.4) / 2 });

    const f2 = await ledger.getFactStats('f2');
    expect(f2).toEqual({ fact_id: 'f2', trials: 1, mean_score: 0.8 });
  });

  it('returns null stats for facts that appeared in no run', async () => {
    await ledger.recordOutcome({ run_id: 'r1', score: 0.5, fact_ids: ['f1'] });
    expect(await ledger.getFactStats('unknown')).toBeNull();
  });

  it('is idempotent on run_id — re-recording replaces the earlier outcome', async () => {
    await ledger.recordOutcome({ run_id: 'r1', score: 0.2, fact_ids: ['f1'] });
    await ledger.recordOutcome({ run_id: 'r1', score: 0.9, fact_ids: ['f1'] });

    const stats = await ledger.getFactStats('f1');
    expect(stats).toEqual({ fact_id: 'f1', trials: 1, mean_score: 0.9 });
  });

  it('computes a leave-one-out baseline excluding runs containing the fact', async () => {
    await ledger.recordOutcome({ run_id: 'r1', score: 1.0, fact_ids: ['good'] });
    await ledger.recordOutcome({ run_id: 'r2', score: 0.2, fact_ids: ['bad'] });
    await ledger.recordOutcome({ run_id: 'r3', score: 0.6, fact_ids: [] });

    const all = await ledger.getBaseline();
    expect(all.runs).toBe(3);
    expect(all.mean_score).toBeCloseTo((1.0 + 0.2 + 0.6) / 3);

    const withoutGood = await ledger.getBaseline('good');
    expect(withoutGood.runs).toBe(2);
    expect(withoutGood.mean_score).toBeCloseTo((0.2 + 0.6) / 2);
  });

  it('returns a zero baseline when no comparison runs exist', async () => {
    await ledger.recordOutcome({ run_id: 'r1', score: 0.7, fact_ids: ['f1'] });
    const baseline = await ledger.getBaseline('f1');
    expect(baseline).toEqual({ runs: 0, mean_score: 0 });
  });

  it('deduplicates fact_ids within a single run in listFactStats', async () => {
    await ledger.recordOutcome({ run_id: 'r1', score: 0.6, fact_ids: ['f1', 'f1'] });
    const stats = await ledger.listFactStats();
    expect(stats).toEqual([{ fact_id: 'f1', trials: 1, mean_score: 0.6 }]);
  });

  it('rejects out-of-range scores via the schema', async () => {
    await expect(ledger.recordOutcome({ run_id: 'r1', score: 1.5, fact_ids: [] })).rejects.toThrow();
    expect(() => RunOutcomeSchema.parse({ run_id: 'r1', score: -0.1 })).toThrow();
  });

  it('clear() removes all recorded outcomes', async () => {
    await ledger.recordOutcome({ run_id: 'r1', score: 0.5, fact_ids: ['f1'] });
    await ledger.clear();
    expect(await ledger.getFactStats('f1')).toBeNull();
    expect((await ledger.getBaseline()).runs).toBe(0);
  });
});
