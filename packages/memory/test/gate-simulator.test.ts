import { describe, it, expect } from 'vitest';
import {
  simulateGate,
  gateOperatingCharacteristics,
} from '../src/validation/gate-simulator.js';

// These are the gate's behavioral guarantees, pinned as regression
// tests: any future change to the estimator, the retrieval policy, or
// the ledger that degrades the operating characteristics fails here.
// Everything is seeded — failures are reproducible, not flaky.

// restAfterTrials 5: under doubling sequential control the with-sample
// freezes at rest, so cohorts need enough trials to decide in the early
// (cheap) alpha brackets before the penalty outgrows the evidence.
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

  it('promotes a strongly helpful lesson and evicts a strongly harmful one', async () => {
    // Arrivals are staggered: two opposite-effect lessons arriving
    // together would be co-injected and cancel — the co-injection
    // confound this gate explicitly does not solve. Staggering gives
    // each lesson runs where its effect is identifiable.
    // 'bad' arrives once 'good' is verified and the baseline is
    // homogeneous — early arrival would dilute its observed lift with
    // pre-learning baseline runs (measured: −0.22 observed vs −0.3 true).
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
});

describe('simulateGate — stopping rules', () => {
  it('maxBaselineRuns retires a candidate the bracket penalty made undecidable', async () => {
    // A modest harmful effect trialled early: baseline heterogeneity +
    // frozen with-sample + growing brackets → never reaches a verdict.
    // Without the baseline-side stopping rule this would be held forever
    // (trials freeze at rest, so maxTrials cannot fire).
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
    const withStop = await simulateGate({
      ...config,
      policy: { minTrials: 3, maxBaselineRuns: 40 },
    });

    expect(without.lessons.find((l) => l.id === 'meh')!.outcome).toBe('held');
    const meh = withStop.lessons.find((l) => l.id === 'meh')!;
    expect(meh.outcome).toBe('evicted');
    expect(meh.reason).toBe('eval-gate:no_lift');
  });
});

describe('gate operating characteristics (regression guarantees)', () => {
  it('zero-effect lessons are false-promoted at most ~10% of the time', async () => {
    const rows = await gateOperatingCharacteristics({
      effects: [0],
      runCounts: [40],
      noiseSds: [0.1],
      replicates: 40,
      seed: 11,
      retrieval: RETRIEVAL,
      policy: { minTrials: 3 }, // no maxTrials: nulls should be HELD, not decided
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

  it('small effects at small n are mostly held — the gate does not guess', async () => {
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

  it('the inference rule has a lower false-positive rate than the margin rule', async () => {
    // Same seeds, same null lessons, same noise — the only difference is
    // the decision rule. This pins the claimed improvement.
    const common = {
      effects: [0],
      runCounts: [30],
      noiseSds: [0.15],
      replicates: 40,
      seed: 19,
      retrieval: RETRIEVAL,
    } as const;

    const margin = await gateOperatingCharacteristics({
      ...common,
      policy: { minTrials: 3, decisionRule: 'margin' },
    });
    const inference = await gateOperatingCharacteristics({
      ...common,
      policy: { minTrials: 3, decisionRule: 'inference' },
    });

    const marginFp = margin[0].falsePromoteRate + margin[0].falseEvictRate;
    const inferenceFp = inference[0].falsePromoteRate + inference[0].falseEvictRate;
    expect(inferenceFp).toBeLessThan(marginFp);
    // And the margin rule on noisy nulls is demonstrably trigger-happy,
    // which is exactly why the inference rule exists.
    expect(marginFp).toBeGreaterThan(0.2);
    expect(inferenceFp).toBeLessThanOrEqual(0.1);
  });
});
