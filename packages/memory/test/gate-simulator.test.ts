/**
 * The gate validation simulator (validation/gate-simulator). It drives
 * the real store/ledger/retriever/gate pipeline with synthetic outcomes
 * to measure the retention gate's realized operating characteristics.
 * Everything is seeded, so these behavioral guarantees are reproducible
 * regression pins rather than flaky expectations.
 */

import { describe, it, expect } from 'vitest';
import {
  simulateGate,
  gateOperatingCharacteristics,
} from '../src/validation/gate-simulator.js';

const RETRIEVAL = { maxFacts: 8, candidateSlots: 4, restAfterTrials: 5 };
const POLICY = { minTrials: 3, maxTrials: 12 } as const;

describe('simulateGate', () => {
  it('is byte-deterministic for a fixed seed', async () => {
    const config = {
      lessons: [
        { id: 'good', trueEffect: 0.2, arrivesAtRun: 1 },
        { id: 'bad', trueEffect: -0.2, arrivesAtRun: 3 },
      ],
      runs: 30,
      seed: 42,
      retrieval: RETRIEVAL,
      policy: POLICY,
    };

    const a = await simulateGate(config);
    const b = await simulateGate(config);

    expect(b).toEqual(a);
  });

  it('is byte-deterministic under default retrieval and policy', async () => {
    const config = {
      lessons: [{ id: 'good', trueEffect: 0.3, arrivesAtRun: 1 }],
      runs: 20,
      seed: 5,
    };

    const a = await simulateGate(config);
    const b = await simulateGate(config);

    expect(b).toEqual(a);
    expect(a.runScores).toHaveLength(20);
  });

  it('promotes a strongly helpful lesson and evicts a strongly harmful one', async () => {
    const result = await simulateGate({
      lessons: [
        { id: 'good', trueEffect: 0.3, arrivesAtRun: 1 },
        { id: 'bad', trueEffect: -0.3, arrivesAtRun: 20 },
      ],
      runs: 45,
      noiseSd: 0.1,
      seed: 7,
      retrieval: RETRIEVAL,
      policy: POLICY,
    });

    const good = result.lessons.find((l) => l.id === 'good')!;
    const bad = result.lessons.find((l) => l.id === 'bad')!;
    expect(good.outcome).toBe('promoted');
    expect(bad.outcome).toBe('evicted');
    expect(bad.reason).toBe('eval-gate:harmful');
  });

  it('does not record lesson-free runs when recordEmptyRuns is false', async () => {
    const result = await simulateGate({
      lessons: [],
      runs: 5,
      seed: 3,
      recordEmptyRuns: false,
    });

    expect(result.runScores).toHaveLength(5);
    expect(result.lessons).toEqual([]);
    expect(result.gateReports.every((g) => g.report.held.length === 0)).toBe(true);
    expect(result.gateReports.every((g) => g.report.promoted.length === 0)).toBe(true);
  });

  it('runs the gate only every gateEvery runs', async () => {
    const result = await simulateGate({
      lessons: [{ id: 'good', trueEffect: 0.3, arrivesAtRun: 1 }],
      runs: 4,
      seed: 9,
      gateEvery: 2,
      retrieval: RETRIEVAL,
      policy: POLICY,
    });

    expect(result.gateReports.map((g) => g.afterRun)).toEqual([2, 4]);
  });
});

describe('simulateGate — stopping rules', () => {
  it('retires a candidate the bracket penalty made undecidable via maxBaselineRuns', async () => {
    const config = {
      lessons: [
        { id: 'good', trueEffect: 0.3, arrivesAtRun: 1 },
        { id: 'meh', trueEffect: -0.1, arrivesAtRun: 12 },
      ],
      runs: 60,
      noiseSd: 0.1,
      seed: 7,
      retrieval: RETRIEVAL,
    };

    const without = await simulateGate({ ...config, policy: { minTrials: 3 } });
    const withStop = await simulateGate({ ...config, policy: { minTrials: 3, maxBaselineRuns: 40 } });

    expect(without.lessons.find((l) => l.id === 'meh')!.outcome).toBe('held');
    const meh = withStop.lessons.find((l) => l.id === 'meh')!;
    expect(meh.outcome).toBe('evicted');
    expect(meh.reason).toBe('eval-gate:no_lift');
  });
});

describe('gateOperatingCharacteristics', () => {
  it('false-promotes zero-effect lessons at most ~10% of the time', async () => {
    const rows = await gateOperatingCharacteristics({
      effects: [0],
      runCounts: [40],
      noiseSds: [0.1],
      replicates: 40,
      seed: 11,
      retrieval: RETRIEVAL,
      policy: { minTrials: 3 },
    });

    expect(rows[0].falsePromoteRate).toBeLessThanOrEqual(0.1);
    expect(rows[0].falseEvictRate).toBeLessThanOrEqual(0.1);
  });

  it('detects |effect| = 0.3 at ≥ 90% within 25 runs at noise 0.1', async () => {
    const rows = await gateOperatingCharacteristics({
      effects: [0.3, -0.3],
      runCounts: [25],
      noiseSds: [0.1],
      replicates: 30,
      seed: 13,
      retrieval: RETRIEVAL,
      policy: POLICY,
    });

    const positive = rows.find((r) => r.effect === 0.3)!;
    const negative = rows.find((r) => r.effect === -0.3)!;
    expect(positive.promoteRate).toBeGreaterThanOrEqual(0.9);
    expect(negative.evictRate).toBeGreaterThanOrEqual(0.9);
  });

  it('mostly holds small effects at small n — the gate does not guess', async () => {
    const rows = await gateOperatingCharacteristics({
      effects: [0.05],
      runCounts: [10],
      noiseSds: [0.15],
      replicates: 30,
      seed: 17,
      retrieval: RETRIEVAL,
      policy: { minTrials: 3 },
    });

    expect(rows[0].heldRate).toBeGreaterThanOrEqual(0.7);
  });

  it('has a lower false-positive rate under the inference rule than the margin rule', async () => {
    const common = {
      effects: [0],
      runCounts: [30],
      noiseSds: [0.15],
      replicates: 40,
      seed: 19,
      retrieval: RETRIEVAL,
    } as const;

    const margin = await gateOperatingCharacteristics({ ...common, policy: { minTrials: 3, decisionRule: 'margin' } });
    const inference = await gateOperatingCharacteristics({ ...common, policy: { minTrials: 3, decisionRule: 'inference' } });

    const marginFp = margin[0].falsePromoteRate + margin[0].falseEvictRate;
    const inferenceFp = inference[0].falsePromoteRate + inference[0].falseEvictRate;
    expect(inferenceFp).toBeLessThan(marginFp);
    expect(marginFp).toBeGreaterThan(0.2);
    expect(inferenceFp).toBeLessThanOrEqual(0.1);
  });

  it('reports no-lift evictions separately from harmful ones', async () => {
    const rows = await gateOperatingCharacteristics({
      effects: [0],
      runCounts: [12],
      noiseSds: [0.1],
      replicates: 20,
      seed: 23,
      retrieval: { maxFacts: 8, candidateSlots: 4 },
      policy: { minTrials: 3, maxTrials: 8 },
    });

    expect(rows[0].noLiftRate).toBeGreaterThan(0);
    expect(rows[0].evictRate).toBeCloseTo(rows[0].harmfulEvictRate + rows[0].noLiftRate, 10);
  });

  it('applies default noiseSd, replicates, and seed when omitted', async () => {
    const rows = await gateOperatingCharacteristics({
      effects: [0.3],
      runCounts: [8],
      retrieval: RETRIEVAL,
      policy: POLICY,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].replicates).toBe(20);
    expect(rows[0].noiseSd).toBe(0.1);
  });

  it('rejects more than 999 replicates to keep seed streams from colliding', async () => {
    await expect(
      gateOperatingCharacteristics({ effects: [0], runCounts: [5], replicates: 1000 }),
    ).rejects.toThrow(RangeError);
  });
});
