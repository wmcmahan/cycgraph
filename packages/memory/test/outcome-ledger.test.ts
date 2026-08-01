/**
 * The in-memory outcome ledger and its run-outcome schema
 * (consolidation/outcome-ledger). The ledger accumulates per-fact
 * evidence (trials, mean, sample variance) and leave-one-out baselines
 * that the retention gate consumes.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryOutcomeLedger, RunOutcomeSchema } from '../src/consolidation/outcome-ledger.js';

describe('RunOutcomeSchema', () => {
  it('defaults fact_ids to an empty array', () => {
    const parsed = RunOutcomeSchema.parse({ run_id: 'r1', score: 0.5 });

    expect(parsed.fact_ids).toEqual([]);
  });

  it('coerces recorded_at from an ISO string', () => {
    const parsed = RunOutcomeSchema.parse({ run_id: 'r1', score: 0.5, recorded_at: '2024-01-01T00:00:00.000Z' });

    expect(parsed.recorded_at).toEqual(new Date('2024-01-01T00:00:00.000Z'));
  });

  it('rejects scores outside [0, 1]', () => {
    expect(() => RunOutcomeSchema.parse({ run_id: 'r1', score: 1.5 })).toThrow();
    expect(() => RunOutcomeSchema.parse({ run_id: 'r1', score: -0.1 })).toThrow();
  });

  it('rejects an empty run_id', () => {
    expect(() => RunOutcomeSchema.parse({ run_id: '', score: 0.5 })).toThrow();
  });
});

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
    expect(f1?.variance).toBeCloseTo(0.08, 10);
  });

  it('omits variance for a single-trial fact rather than reporting 0', async () => {
    await ledger.recordOutcome({ run_id: 'r1', score: 0.8, fact_ids: ['f2'] });

    const f2 = await ledger.getFactStats('f2');

    expect(f2?.trials).toBe(1);
    expect(f2?.meanScore).toBeCloseTo(0.8, 10);
    expect(f2?.variance).toBeUndefined();
  });

  it('returns null stats for a fact that appeared in no run', async () => {
    await ledger.recordOutcome({ run_id: 'r1', score: 0.5, fact_ids: ['f1'] });

    expect(await ledger.getFactStats('unknown')).toBeNull();
  });

  it('is idempotent on run_id — re-recording replaces the earlier outcome', async () => {
    await ledger.recordOutcome({ run_id: 'r1', score: 0.2, fact_ids: ['f1'] });
    await ledger.recordOutcome({ run_id: 'r1', score: 0.9, fact_ids: ['f1'] });

    expect(await ledger.getFactStats('f1')).toEqual({ factId: 'f1', trials: 1, meanScore: 0.9 });
  });

  it('exposes baseline variance once the baseline has 2+ runs', async () => {
    await ledger.recordOutcome({ run_id: 'r1', score: 0.4, fact_ids: [] });
    await ledger.recordOutcome({ run_id: 'r2', score: 0.8, fact_ids: [] });

    const baseline = await ledger.getBaseline();

    expect(baseline.runs).toBe(2);
    expect(baseline.meanScore).toBeCloseTo(0.6, 10);
    expect(baseline.variance).toBeCloseTo(0.08, 10);
  });

  it('computes a leave-one-out baseline excluding runs containing the fact', async () => {
    await ledger.recordOutcome({ run_id: 'r1', score: 1.0, fact_ids: ['good'] });
    await ledger.recordOutcome({ run_id: 'r2', score: 0.2, fact_ids: ['bad'] });
    await ledger.recordOutcome({ run_id: 'r3', score: 0.6, fact_ids: [] });

    const all = await ledger.getBaseline();
    const withoutGood = await ledger.getBaseline('good');

    expect(all.runs).toBe(3);
    expect(all.meanScore).toBeCloseTo((1.0 + 0.2 + 0.6) / 3, 10);
    expect(withoutGood.runs).toBe(2);
    expect(withoutGood.meanScore).toBeCloseTo((0.2 + 0.6) / 2, 10);
  });

  it('counts runs that simply lack the excluded fact in the baseline', async () => {
    await ledger.recordOutcome({ run_id: 'r1', score: 0.4, fact_ids: [] });
    await ledger.recordOutcome({ run_id: 'r2', score: 0.8, fact_ids: [] });

    const baseline = await ledger.getBaseline('absent-fact');

    expect(baseline.runs).toBe(2);
    expect(baseline.variance).toBeCloseTo(0.08, 10);
  });

  it('returns a zero baseline when no comparison runs exist', async () => {
    await ledger.recordOutcome({ run_id: 'r1', score: 0.7, fact_ids: ['f1'] });

    expect(await ledger.getBaseline('f1')).toEqual({ runs: 0, meanScore: 0 });
  });

  it('deduplicates fact_ids within a single run for listFactStats', async () => {
    await ledger.recordOutcome({ run_id: 'r1', score: 0.6, fact_ids: ['f1', 'f1'] });

    expect(await ledger.listFactStats()).toEqual([{ factId: 'f1', trials: 1, meanScore: 0.6 }]);
  });

  it('lists per-fact stats sorted by id, with variance for multi-run facts', async () => {
    await ledger.recordOutcome({ run_id: 'r1', score: 0.8, fact_ids: ['f2', 'f1'] });
    await ledger.recordOutcome({ run_id: 'r2', score: 0.4, fact_ids: ['f1'] });

    const stats = await ledger.listFactStats();

    expect(stats).toHaveLength(2);
    expect(stats[0].factId).toBe('f1');
    expect(stats[0].trials).toBe(2);
    expect(stats[0].meanScore).toBeCloseTo(0.6, 10);
    expect(stats[0].variance).toBeCloseTo(0.08, 10);
    expect(stats[1]).toEqual({ factId: 'f2', trials: 1, meanScore: 0.8 });
  });

  it('deduplicates fact_ids within a single run for getFactStatsBatch', async () => {
    await ledger.recordOutcome({ run_id: 'r1', score: 0.6, fact_ids: ['f1', 'f1'] });

    const batch = await ledger.getFactStatsBatch(['f1']);

    expect(batch.get('f1')).toEqual({ factId: 'f1', trials: 1, meanScore: 0.6 });
  });

  it('getFactStatsBatch matches per-id getFactStats and omits unseen ids', async () => {
    await ledger.recordOutcome({ run_id: 'r1', score: 0.8, fact_ids: ['f1', 'f2'] });
    await ledger.recordOutcome({ run_id: 'r2', score: 0.4, fact_ids: ['f1'] });

    const batch = await ledger.getFactStatsBatch(['f1', 'f2', 'f3']);

    expect(batch.get('f1')).toEqual(await ledger.getFactStats('f1'));
    expect(batch.get('f2')).toEqual(await ledger.getFactStats('f2'));
    expect(batch.has('f3')).toBe(false);
  });

  it('rejects out-of-range scores at record time', async () => {
    await expect(ledger.recordOutcome({ run_id: 'r1', score: 1.5, fact_ids: [] })).rejects.toThrow();
  });

  it('clears all recorded outcomes', async () => {
    await ledger.recordOutcome({ run_id: 'r1', score: 0.5, fact_ids: ['f1'] });

    await ledger.clear();

    expect(await ledger.getFactStats('f1')).toBeNull();
    expect((await ledger.getBaseline()).runs).toBe(0);
  });
});
