import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryOutcomeLedger, RunOutcomeSchema } from '../src/consolidation/outcome-ledger.js';

describe('InMemoryOutcomeLedger', () => {
  let ledger: InMemoryOutcomeLedger;

  beforeEach(() => {
    ledger = new InMemoryOutcomeLedger();
  });

  it('accumulates per-fact trials, mean, and sample variance', async () => {
    await ledger.recordOutcome({ run_id: 'r1', score: 0.8, fact_ids: ['f1', 'f2'] });
    await ledger.recordOutcome({ run_id: 'r2', score: 0.4, fact_ids: ['f1'] });

    const f1 = await ledger.getFactStats('f1');
    expect(f1?.trials).toBe(2);
    expect(f1?.meanScore).toBeCloseTo(0.6, 10);
    // Sample variance (n−1): (0.2² + 0.2²) / 1 = 0.08
    expect(f1?.variance).toBeCloseTo(0.08, 10);

    // A single trial has no variance — the field is absent, not 0.
    const f2 = await ledger.getFactStats('f2');
    expect(f2?.trials).toBe(1);
    expect(f2?.meanScore).toBeCloseTo(0.8, 10);
    expect(f2?.variance).toBeUndefined();
  });

  it('returns null stats for facts that appeared in no run', async () => {
    await ledger.recordOutcome({ run_id: 'r1', score: 0.5, fact_ids: ['f1'] });
    expect(await ledger.getFactStats('unknown')).toBeNull();
  });

  it('is idempotent on run_id — re-recording replaces the earlier outcome', async () => {
    await ledger.recordOutcome({ run_id: 'r1', score: 0.2, fact_ids: ['f1'] });
    await ledger.recordOutcome({ run_id: 'r1', score: 0.9, fact_ids: ['f1'] });

    const stats = await ledger.getFactStats('f1');
    expect(stats).toEqual({ factId: 'f1', trials: 1, meanScore: 0.9 });
  });

  it('exposes baseline variance once the baseline has 2+ runs', async () => {
    await ledger.recordOutcome({ run_id: 'r1', score: 0.4, fact_ids: [] });
    await ledger.recordOutcome({ run_id: 'r2', score: 0.8, fact_ids: [] });

    const baseline = await ledger.getBaseline();
    expect(baseline.runs).toBe(2);
    expect(baseline.meanScore).toBeCloseTo(0.6, 10);
    expect(baseline.variance).toBeCloseTo(0.08, 10);

    // Single-run baseline → no variance field.
    const one = await ledger.getBaseline('f-nonexistent-but-r1-r2-lack-facts');
    expect(one.variance).toBeCloseTo(0.08, 10); // excludes nothing — both runs lack the fact
  });

  it('computes a leave-one-out baseline excluding runs containing the fact', async () => {
    await ledger.recordOutcome({ run_id: 'r1', score: 1.0, fact_ids: ['good'] });
    await ledger.recordOutcome({ run_id: 'r2', score: 0.2, fact_ids: ['bad'] });
    await ledger.recordOutcome({ run_id: 'r3', score: 0.6, fact_ids: [] });

    const all = await ledger.getBaseline();
    expect(all.runs).toBe(3);
    expect(all.meanScore).toBeCloseTo((1.0 + 0.2 + 0.6) / 3);

    const withoutGood = await ledger.getBaseline('good');
    expect(withoutGood.runs).toBe(2);
    expect(withoutGood.meanScore).toBeCloseTo((0.2 + 0.6) / 2);
  });

  it('returns a zero baseline when no comparison runs exist', async () => {
    await ledger.recordOutcome({ run_id: 'r1', score: 0.7, fact_ids: ['f1'] });
    const baseline = await ledger.getBaseline('f1');
    expect(baseline).toEqual({ runs: 0, meanScore: 0 });
  });

  it('deduplicates fact_ids within a single run in listFactStats', async () => {
    await ledger.recordOutcome({ run_id: 'r1', score: 0.6, fact_ids: ['f1', 'f1'] });
    const stats = await ledger.listFactStats();
    expect(stats).toEqual([{ factId: 'f1', trials: 1, meanScore: 0.6 }]);
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

  it('getFactStatsBatch matches per-id getFactStats and omits unseen ids', async () => {
    await ledger.recordOutcome({ run_id: 'r1', score: 0.8, fact_ids: ['f1', 'f2'] });
    await ledger.recordOutcome({ run_id: 'r2', score: 0.4, fact_ids: ['f1'] });

    const batch = await ledger.getFactStatsBatch(['f1', 'f2', 'f3']);
    expect(batch.get('f1')).toEqual(await ledger.getFactStats('f1'));
    expect(batch.get('f2')).toEqual(await ledger.getFactStats('f2'));
    expect(batch.has('f3')).toBe(false);
  });
});
