/**
 * Deterministic regression test for the eval-gated-learning demo.
 *
 * The live example (`examples/eval-gated-learning/`) proves the mechanism
 * end to end with real LLMs — real, but non-deterministic and ~$1/run, so
 * it can't gate CI. This test reproduces the *gate* half of that demo with
 * the SAME real `@cycgraph/memory` primitives (`InMemoryMemoryStore`,
 * `InMemoryOutcomeLedger`, `evaluateRetention`) but synthetic, fixed
 * outcomes — so it's free, <1s, and fails loudly if the retention gate
 * stops evicting poison or promoting genuine lessons.
 *
 * (Provenance attribution from prompts — the other half — is unit-tested
 * in `@cycgraph/orchestrator`'s lesson-provenance suite.)
 *
 * It also makes the README's honesty point concrete: on the SAME limited
 * evidence, the production-default `inference` rule is strictly more
 * conservative than the fast `margin` rule the demo pins.
 */

import { describe, test, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  InMemoryMemoryStore,
  InMemoryOutcomeLedger,
  evaluateRetention,
  type SemanticFact,
  type RunOutcome,
} from '@cycgraph/memory';
import { computeVerdict } from '../examples/eval-gated-learning/verdict.js';

const TAG = 'graph:eval-gated-learning-v1';

function candidate(content: string): SemanticFact {
  return {
    id: randomUUID(),
    content,
    source_episode_ids: [],
    entity_ids: [],
    provenance: { source: 'system', created_at: new Date() },
    valid_from: new Date(),
    tags: ['lesson', TAG, 'candidate'],
  };
}

/**
 * Stand up a store + ledger with two genuine lessons and three poison
 * lessons (candidates), then feed a fixed outcome sequence in which runs
 * carrying poison score low and runs carrying only genuine lessons score
 * high. Good and poison never co-occur — so each fact's leave-one-out
 * baseline cleanly isolates its effect (the demo's dedup guard plays the
 * same role of keeping cohorts separable).
 */
async function buildScenario(opts: { goodScore: number; poisonScore: number; trials: number }) {
  const store = new InMemoryMemoryStore();
  const ledger = new InMemoryOutcomeLedger();

  const good = [candidate('Cite at least three named sources with years.'), candidate('Include a Counterarguments section.')];
  const poison = [
    candidate('Omit any Counterarguments section.'),
    candidate('Never cite named sources or years.'),
    candidate('Do not state confidence levels.'),
  ];
  for (const f of [...good, ...poison]) await store.putFact(f);

  const goodIds = good.map((f) => f.id);
  const poisonIds = poison.map((f) => f.id);

  const outcomes: RunOutcome[] = [];
  let n = 0;
  for (let i = 0; i < opts.trials; i++) {
    // Genuine-lesson run: both good lessons present, no poison → high.
    outcomes.push({ run_id: `good-${n++}`, score: opts.goodScore, fact_ids: [...goodIds] });
    // Poison run: all three poison present, no good → low.
    outcomes.push({ run_id: `poison-${n++}`, score: opts.poisonScore, fact_ids: [...poisonIds] });
  }
  for (const o of outcomes) await ledger.recordOutcome(o);

  return { store, ledger, goodIds, poisonIds };
}

describe('eval-gated-learning gate (deterministic)', () => {
  test('margin rule evicts every poison lesson and promotes the genuine ones', async () => {
    const { store, ledger, goodIds, poisonIds } = await buildScenario({
      goodScore: 0.9,
      poisonScore: 0.3,
      trials: 3,
    });

    const report = await evaluateRetention(store, ledger, {
      decision_rule: 'margin',
      min_trials: 2,
      promote_margin: 0.05,
      evict_margin: 0.05,
      max_trials: 6,
    });

    const evictedIds = report.evicted.map((e) => e.fact_id).sort();
    const promotedIds = report.promoted.map((p) => p.fact_id).sort();

    expect(evictedIds).toEqual([...poisonIds].sort());
    expect(promotedIds).toEqual([...goodIds].sort());
    for (const e of report.evicted) expect(e.reason).toMatch(/^eval-gate:/);

    // The store reflects the decisions: poison invalidated, good verified.
    for (const id of poisonIds) {
      expect((await store.getFact(id))?.invalidated_by).toMatch(/^eval-gate:/);
    }
    const verified = await store.findFacts({ tags: ['verified'], include_invalidated: false });
    expect(verified.map((f) => f.id).sort()).toEqual([...goodIds].sort());
  });

  test('inference rule is strictly more conservative on the SAME limited evidence', async () => {
    // Modest effect, just 2 trials per cohort — the regime where the
    // point-estimate margin rule fires but the statistically-controlled
    // inference rule rightly withholds judgement.
    const POLICY_BASE = { min_trials: 2, promote_margin: 0.05, evict_margin: 0.05, max_trials: 6 };
    const SCENARIO = { goodScore: 0.62, poisonScore: 0.5, trials: 2 };

    const m = await buildScenario(SCENARIO);
    const marginReport = await evaluateRetention(m.store, m.ledger, { ...POLICY_BASE, decision_rule: 'margin' });

    const i = await buildScenario(SCENARIO);
    const inferenceReport = await evaluateRetention(i.store, i.ledger, { ...POLICY_BASE, decision_rule: 'inference' });

    // Margin rushes to judge on this thin evidence: it evicts all 3 poison.
    expect(marginReport.evicted.length).toBe(m.poisonIds.length);
    // Inference withholds judgement entirely — it holds everything (no
    // promotion, no eviction) until there's real evidence volume. This is
    // the README's "under inference this demo holds everything", executable.
    expect(inferenceReport.evicted.length).toBe(0);
    expect(inferenceReport.promoted.length).toBe(0);
    expect(inferenceReport.evicted.length).toBeLessThan(marginReport.evicted.length);
  });

  test('computeVerdict passes on a healthy run and fails when poison survives', () => {
    const records = [
      { run: 1, fitness: 0.9, injected_fact_ids: ['g1'], poison_injected_count: 0 },
      { run: 2, fitness: 0.4, injected_fact_ids: ['g1', 'p1'], poison_injected_count: 1 },
      { run: 3, fitness: 0.92, injected_fact_ids: ['g1'], poison_injected_count: 0 },
    ];
    const healthy = computeVerdict({
      records,
      poisonIds: ['p1'],
      poisonEvicted: 1,
      poisonEvictedAfterRun: 2,
      verifiedCount: 2,
    });
    expect(healthy.passed).toBe(true);

    const broken = computeVerdict({
      records,
      poisonIds: ['p1'],
      poisonEvicted: 0, // poison survived
      poisonEvictedAfterRun: null,
      verifiedCount: 2,
    });
    expect(broken.passed).toBe(false);
    expect(broken.checks.find((c) => c.name.includes('all poison evicted'))?.passed).toBe(false);
  });
});
