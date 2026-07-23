/**
 * Retention Gate
 *
 * The eval-gating decision: given accumulated run-outcome evidence (an
 * `OutcomeLedger`), promote candidate lessons that demonstrably lift
 * outcomes and evict the ones that hurt or never help.
 *
 * Lesson lifecycle is tag-driven:
 *
 *   candidate ──(lift confirmed)──▶ verified
 *      │
 *      ├──(harm confirmed)──────────▶ invalidated 'eval-gate:harmful'
 *      └──(maxTrials, no verdict)──▶ invalidated 'eval-gate:no_lift'
 *
 * Two decision rules:
 *
 * - `'inference'` (default) — Welch-style inference on the lift between
 *   runs WITH the lesson and the leave-one-out baseline WITHOUT it.
 *   Promote when P(lift > promoteMargin) clears `promoteConfidence`;
 *   evict when P(lift < −evictMargin) clears `evictConfidence`.
 *   Benjamini–Hochberg controls the false-discovery rate across the
 *   many lessons tested in one pass. Margins keep their meaning as
 *   practical-significance floors; the confidences are the new
 *   statistical bar.
 *
 * - `'margin'` — the original point-estimate comparison (mean vs
 *   leave-one-out mean against a fixed margin). Kept for callers that
 *   prefer fast verdicts over statistical guarantees, and as the
 *   pinned-behavior baseline in tests.
 *
 * Honest limits, stated plainly: this is observational inference over
 * co-injected lessons — correlational, not causal. A genuine lesson
 * co-injected with a harmful one during a disaster run can be blamed
 * for it. The inference rule quantifies uncertainty; it does not remove
 * confounding. Use `gateOperatingCharacteristics` (validation/) to
 * measure realized error rates for your policy before trusting it.
 *
 * Uses the same collect-then-apply mutation pattern and soft-delete
 * convention (`invalidated_by`) as `MemoryConsolidator`, so evicted
 * facts remain recoverable via `findFacts({ includeInvalidated: true })`.
 *
 * Re-running the gate is idempotent: promoted facts no longer carry the
 * candidate tag, and evicted facts are excluded from the default
 * `findFacts` listing.
 *
 * @module consolidation/retention-gate
 */

import { z } from 'zod';
import { QUARANTINE_TAG, type MemoryStore } from '../interfaces/memory-store.js';
import type { SemanticFact } from '../schemas/semantic.js';
import type { OutcomeLedger } from './outcome-ledger.js';
import { welchLift, benjaminiHochberg } from '../utils/statistics.js';

export const RetentionPolicySchema = z.object({
  /** Minimum runs a candidate must appear in before any decision. */
  minTrials: z.number().int().min(1).default(3),
  /** Practical-significance floor for promotion (lift must exceed it). */
  promoteMargin: z.number().min(0).default(0.05),
  /** Practical-significance floor for eviction (drop must exceed it). */
  evictMargin: z.number().min(0).default(0.05),
  /** Tag marking unproven lessons. */
  candidateTag: z.string().default('candidate'),
  /** Tag marking lessons that earned their place. */
  verifiedTag: z.string().default('verified'),
  /**
   * Trials after which a candidate with no verdict is evicted as
   * useless. Also the escape hatch for candidates whose baseline can
   * never form. Omit to keep undecided candidates on trial forever.
   *
   * NOTE: when retrieval benches candidates (`restAfterTrials`),
   * trials freeze below this cap and it never fires — pair it with
   * `maxBaselineRuns`, the baseline-side stopping rule.
   */
  maxTrials: z.number().int().min(1).optional(),
  /**
   * Retire a still-undecided candidate (as `'eval-gate:no_lift'`) once
   * its leave-one-out baseline reaches this many runs. With a frozen
   * with-sample (rest phase) and doubling sequential control, the
   * evidence a candidate can ever produce is bounded while the test
   * threshold keeps tightening — past some baseline size it is
   * undecidable by construction. This closes that window explicitly.
   */
  maxBaselineRuns: z.number().int().min(2).optional(),
  /**
   * `'inference'` (default): Welch-style test with FDR control.
   * `'margin'`: the original point-estimate rule — faster verdicts,
   * no statistical guarantee.
   */
  decisionRule: z.enum(['margin', 'inference']).default('inference'),
  /** Required P(lift > promoteMargin) to promote (inference rule). */
  promoteConfidence: z.number().min(0.5).max(0.999).default(0.9),
  /** Required P(lift < −evictMargin) to evict (inference rule). */
  evictConfidence: z.number().min(0.5).max(0.999).default(0.9),
  /**
   * Per-group SD floor applied before the Welch test (inference rule).
   * Variance estimates from 2–3 runs are unstable; the floor encodes
   * the known scale of judge noise so tiny samples can't fake
   * certainty. Set it to your judge's observed per-run SD.
   */
  noiseFloorSd: z.number().min(0).default(0.1),
  /**
   * `'bh'` (default): Benjamini–Hochberg FDR control across all
   * candidates tested in one gate pass, at q = 1 − confidence.
   * `'none'`: per-candidate confidence threshold only.
   */
  multipleComparison: z.enum(['bh', 'none']).default('bh'),
  /**
   * Sequential-testing control. Gating repeatedly as evidence trickles
   * in is "peeking": a 90%-confidence test re-taken on every pass can
   * easily triple its false-positive rate (our own simulator measured
   * 25% before this control existed). `'doubling'` (default) spends the
   * error budget across baseline-size brackets — a candidate is only
   * tested when its baseline has 2, 4, 8, 16… runs, with the per-bracket
   * threshold halving each time (union bound: total α stays ≤ 1 −
   * confidence across unlimited looks; within-bracket re-looks share
   * nearly identical data). `'none'` tests at every pass at the flat
   * confidence — only sound if you gate once.
   */
  sequentialControl: z.enum(['doubling', 'none']).default('doubling'),
}).refine(
  (p) => p.maxTrials === undefined || p.maxTrials >= p.minTrials,
  {
    message:
      'maxTrials must be >= minTrials: a candidate below minTrials is held ' +
      'before the maxTrials retirement check can fire, silently delaying it',
  },
);

export type RetentionPolicy = z.infer<typeof RetentionPolicySchema>;

export type EvictionReason = 'eval-gate:harmful' | 'eval-gate:no_lift';

/** Statistical evidence behind one gate decision (inference rule only). */
export interface RetentionEvidence {
  /** Point estimate: mean(runs with) − mean(leave-one-out baseline). */
  lift: number;
  /** Welch standard error of the lift (after the noise floor). */
  se: number;
  /** Welch–Satterthwaite degrees of freedom. */
  df: number;
  /** P(true lift > promoteMargin). */
  pPromote: number;
  /** P(true lift < −evictMargin). */
  pEvict: number;
  /** Runs containing the lesson. */
  trials: number;
  /** Leave-one-out baseline runs. */
  baselineRuns: number;
  /**
   * Sequential-control bracket this test ran in (doubling control):
   * bracket k covers baseline sizes [2^k, 2^(k+1)) and tests at
   * threshold (1 − confidence) / 2^k. Absent under `'none'`.
   */
  alphaBracket?: number;
}

export interface RetentionReport {
  /** Lessons promoted candidate → verified this pass. */
  promoted: Array<{ factId: string; evidence?: RetentionEvidence }>;
  /** Lessons invalidated this pass, with the gate's reason. */
  evicted: Array<{ factId: string; reason: EvictionReason; evidence?: RetentionEvidence }>;
  /** Candidates left on trial (insufficient evidence either way). */
  held: Array<{ factId: string; trials: number; evidence?: RetentionEvidence }>;
}

interface Assessment {
  fact: SemanticFact;
  trials: number;
  baselineRuns: number;
  evidence?: RetentionEvidence;
  /** Stage-1 verdict for candidates that never reach the test. */
  early?: 'held' | 'no_lift';
  /** Margin-rule verdict (stage 1 decides everything). */
  marginVerdict?: 'promote' | 'evict' | 'held' | 'no_lift';
}

/**
 * Evaluate every active candidate lesson against the ledger evidence and
 * apply promotions/evictions to the store.
 *
 * @param store - The memory store holding lesson facts.
 * @param ledger - Accumulated run outcomes (see `OutcomeLedger`).
 * @param policy - Thresholds; unspecified fields use schema defaults.
 */
export async function evaluateRetention(
  store: MemoryStore,
  ledger: OutcomeLedger,
  policy: Partial<RetentionPolicy> = {},
): Promise<RetentionReport> {
  const cfg = RetentionPolicySchema.parse(policy);
  const report: RetentionReport = { promoted: [], evicted: [], held: [] };

  // Load active candidates in batches (mirrors MemoryConsolidator).
  const batchSize = 1000;
  const candidates: SemanticFact[] = [];
  let offset = 0;
  while (true) {
    const batch = await store.findFacts({
      tags: [cfg.candidateTag],
      excludeTags: [QUARANTINE_TAG],
      includeInvalidated: false,
      limit: batchSize,
      offset,
    });
    candidates.push(...batch);
    if (batch.length < batchSize) break;
    offset += batchSize;
  }

  // ── Stage 1: per-candidate assessment ──
  const assessments: Assessment[] = [];
  for (const fact of candidates) {
    const stats = await ledger.getFactStats(fact.id);
    const trials = stats?.trials ?? 0;
    const baseline = await ledger.getBaseline(fact.id);

    const base: Assessment = { fact, trials, baselineRuns: baseline.runs };

    if (stats === null || trials < cfg.minTrials) {
      assessments.push({ ...base, early: 'held' });
      continue;
    }

    if (cfg.decisionRule === 'margin') {
      // Original point-estimate rule, behavior-identical to the
      // pre-inference gate (including the empty-baseline escape hatch).
      if (baseline.runs === 0) {
        assessments.push({
          ...base,
          marginVerdict:
            cfg.maxTrials !== undefined && trials >= cfg.maxTrials ? 'no_lift' : 'held',
        });
        continue;
      }
      const lift = stats.meanScore - baseline.meanScore;
      let verdict: Assessment['marginVerdict'];
      if (lift >= cfg.promoteMargin) verdict = 'promote';
      else if (-lift >= cfg.evictMargin) verdict = 'evict';
      else if (cfg.maxTrials !== undefined && trials >= cfg.maxTrials) verdict = 'no_lift';
      else verdict = 'held';
      assessments.push({ ...base, marginVerdict: verdict });
      continue;
    }

    // Inference rule: both groups need n ≥ 2 for a variance estimate.
    // (The noise floor stabilises tiny variances; it can't conjure a
    // degree of freedom.) Undecidable candidates fall back to the
    // maxTrials escape hatch so they can't deadlock the trial queue.
    if (trials < 2 || baseline.runs < 2) {
      assessments.push({
        ...base,
        early: cfg.maxTrials !== undefined && trials >= cfg.maxTrials ? 'no_lift' : 'held',
      });
      continue;
    }

    const floorVar = cfg.noiseFloorSd ** 2;
    const varWith = Math.max(stats.variance ?? 0, floorVar);
    const varWithout = Math.max(baseline.variance ?? 0, floorVar);

    const promo = welchLift({
      meanA: stats.meanScore,
      varA: varWith,
      nA: trials,
      meanB: baseline.meanScore,
      varB: varWithout,
      nB: baseline.runs,
      margin: cfg.promoteMargin,
    });
    // Eviction side: P(lift < −evictMargin) = 1 − P(lift > −evictMargin).
    const evict = welchLift({
      meanA: stats.meanScore,
      varA: varWith,
      nA: trials,
      meanB: baseline.meanScore,
      varB: varWithout,
      nB: baseline.runs,
      margin: -cfg.evictMargin,
    });

    // Sequential control: bracket k covers baseline sizes [2^k, 2^(k+1)).
    // Spending α/2^k per bracket keeps total error ≤ α over unlimited
    // gate passes (union bound across brackets).
    const alphaBracket =
      cfg.sequentialControl === 'doubling' ? Math.floor(Math.log2(baseline.runs)) : undefined;

    assessments.push({
      ...base,
      evidence: {
        lift: promo.lift,
        se: promo.se,
        df: promo.df,
        pPromote: promo.pExceeds,
        pEvict: 1 - evict.pExceeds,
        trials,
        baselineRuns: baseline.runs,
        ...(alphaBracket !== undefined ? { alphaBracket: alphaBracket } : {}),
      },
    });
  }

  // ── Stage 2: decisions (inference rule needs the full pass for FDR) ──
  const tested = assessments.filter((a) => a.evidence !== undefined);
  // One-sided p-values: p = 1 − P(hypothesis | data) under the flat-prior
  // t posterior — numerically the classical one-sided Welch p-value.
  // Under doubling sequential control, the bracket penalty is folded into
  // the p-value (p·2^k ≤ q  ⟺  p ≤ q/2^k), which composes with BH.
  const spend = (a: Assessment, p: number) =>
    a.evidence!.alphaBracket !== undefined ? Math.min(1, p * 2 ** a.evidence!.alphaBracket) : p;
  const promoteP = tested.map((a) => spend(a, 1 - a.evidence!.pPromote));
  const evictP = tested.map((a) => spend(a, 1 - a.evidence!.pEvict));

  let promoteReject: boolean[];
  let evictReject: boolean[];
  if (cfg.multipleComparison === 'bh') {
    promoteReject = benjaminiHochberg(promoteP, 1 - cfg.promoteConfidence);
    evictReject = benjaminiHochberg(evictP, 1 - cfg.evictConfidence);
  } else {
    promoteReject = promoteP.map((p) => p <= 1 - cfg.promoteConfidence);
    evictReject = evictP.map((p) => p <= 1 - cfg.evictConfidence);
  }

  // Collect mutations first; apply at the end so a mid-pass failure
  // never leaves a half-gated store.
  const mutations: SemanticFact[] = [];

  const promote = (fact: SemanticFact, evidence?: RetentionEvidence) => {
    mutations.push({
      ...fact,
      // Set-dedup: a fact already carrying the verified tag (writer bug,
      // manual edit) must not come out tagged verified twice.
      tags: [...new Set([...fact.tags.filter((t) => t !== cfg.candidateTag), cfg.verifiedTag])],
    });
    report.promoted.push({ factId: fact.id, ...(evidence ? { evidence } : {}) });
  };
  const evictAs = (fact: SemanticFact, reason: EvictionReason, evidence?: RetentionEvidence) => {
    mutations.push({ ...fact, invalidated_by: reason });
    report.evicted.push({ factId: fact.id, reason, ...(evidence ? { evidence } : {}) });
  };

  let testedIdx = 0;
  for (const a of assessments) {
    if (a.early !== undefined) {
      if (a.early === 'no_lift') evictAs(a.fact, 'eval-gate:no_lift');
      else report.held.push({ factId: a.fact.id, trials: a.trials });
      continue;
    }
    if (a.marginVerdict !== undefined) {
      if (a.marginVerdict === 'promote') promote(a.fact);
      else if (a.marginVerdict === 'evict') evictAs(a.fact, 'eval-gate:harmful');
      else if (a.marginVerdict === 'no_lift') evictAs(a.fact, 'eval-gate:no_lift');
      else report.held.push({ factId: a.fact.id, trials: a.trials });
      continue;
    }

    const idx = testedIdx++;
    const evidence = a.evidence!;
    const doPromote = promoteReject[idx];
    const doEvict = evictReject[idx];

    // Both sides confirmed is impossible with positive margins unless
    // numerics misbehave — hold defensively if it ever happens (checked
    // FIRST so the stopping rules below can't turn it into an eviction).
    if (doPromote && doEvict) {
      report.held.push({ factId: a.fact.id, trials: a.trials, evidence });
    } else if (doPromote) {
      promote(a.fact, evidence);
    } else if (doEvict) {
      evictAs(a.fact, 'eval-gate:harmful', evidence);
    } else if (
      (cfg.maxTrials !== undefined && a.trials >= cfg.maxTrials) ||
      (cfg.maxBaselineRuns !== undefined && a.baselineRuns >= cfg.maxBaselineRuns)
    ) {
      evictAs(a.fact, 'eval-gate:no_lift', evidence);
    } else {
      report.held.push({ factId: a.fact.id, trials: a.trials, evidence });
    }
  }

  for (const fact of mutations) {
    await store.putFact(fact);
  }

  return report;
}
