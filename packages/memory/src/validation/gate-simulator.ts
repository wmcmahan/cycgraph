/**
 * Gate Validation Simulator
 *
 * Measures the retention gate's *realized* operating characteristics —
 * how often it promotes, evicts, or holds lessons of known true effect
 * under a given policy, run volume, and noise level. The statistical
 * machinery in the gate makes claims; this module is how you check them
 * against YOUR configuration before trusting it.
 *
 * The simulator drives the real production code path — an actual
 * `InMemoryMemoryStore`, `InMemoryOutcomeLedger`, `retrieveGatedLessons`
 * and `evaluateRetention` — with synthetic outcomes:
 *
 *   score(run) = clamp01( base + Σ trueEffect(injected lessons) + N(0, noiseSd) )
 *
 * No LLM, no network: a full operating-characteristics grid runs in
 * seconds and is fully deterministic given a seed.
 *
 * @module validation/gate-simulator
 */

import { InMemoryMemoryStore } from '../store/in-memory-store.js';
import {
  InMemoryOutcomeLedger,
} from '../consolidation/outcome-ledger.js';
import {
  evaluateRetention,
  type RetentionPolicy,
  type RetentionReport,
  type EvictionReason,
} from '../consolidation/retention-gate.js';
import { retrieveGatedLessons } from '../retrieval/gated-lesson-retriever.js';
import { mulberry32, gaussian } from '../utils/statistics.js';
import type { SemanticFact } from '../schemas/semantic.js';

/** Fixed epoch so simulated `valid_from` ordering is deterministic. */
const SIM_EPOCH_MS = Date.UTC(2026, 0, 1);
const SIM_TAG = 'gate-sim';

export interface SimulatedLesson {
  id: string;
  /** True causal effect on the run score when this lesson is injected. */
  trueEffect: number;
  /** First run (1-based) at which the lesson exists as a candidate. */
  arrivesAtRun: number;
}

export interface GateSimulationConfig {
  lessons: SimulatedLesson[];
  /** Total runs to simulate. */
  runs: number;
  /** Score of a lesson-free run before noise (default 0.6). */
  baseScore?: number;
  /** Run-score noise SD — judge noise + run variability (default 0.1). */
  noiseSd?: number;
  /** PRNG seed — same seed, same config → byte-identical results. */
  seed: number;
  /** Passed through to `retrieveGatedLessons`. */
  retrieval?: {
    maxFacts?: number;
    candidateSlots?: number;
    restAfterTrials?: number;
  };
  /** Passed through to `evaluateRetention`. */
  policy?: Partial<RetentionPolicy>;
  /** Gate cadence in runs (default 1 = gate after every run). */
  gateEvery?: number;
  /**
   * Record runs that injected zero lessons (default true). Simulated
   * empty runs are exchangeable with lesson-free reality, so they make
   * clean baselines; live workflows may prefer to skip cold-start runs.
   */
  recordEmptyRuns?: boolean;
}

export interface SimulatedLessonOutcome {
  id: string;
  trueEffect: number;
  outcome: 'promoted' | 'evicted' | 'held';
  reason?: EvictionReason;
  /** Run after which the gate decided (undefined while held). */
  decidedAtRun?: number;
}

export interface GateSimulationResult {
  lessons: SimulatedLessonOutcome[];
  runScores: number[];
  gateReports: Array<{ afterRun: number; report: RetentionReport }>;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

function makeSimFact(lesson: SimulatedLesson, candidateTag: string): SemanticFact {
  return {
    id: lesson.id,
    content: `Simulated lesson ${lesson.id} (true effect ${lesson.trueEffect})`,
    source_episode_ids: [],
    entity_ids: [],
    provenance: { source: 'system', created_at: new Date(SIM_EPOCH_MS) },
    valid_from: new Date(SIM_EPOCH_MS + lesson.arrivesAtRun * 1000),
    tags: ['lesson', SIM_TAG, candidateTag],
  };
}

/**
 * Simulate `runs` workflow runs against the real store/ledger/retriever/
 * gate pipeline with synthetic outcomes. Fully deterministic per seed.
 */
export async function simulateGate(config: GateSimulationConfig): Promise<GateSimulationResult> {
  const base = config.baseScore ?? 0.6;
  const noiseSd = config.noiseSd ?? 0.1;
  const gateEvery = config.gateEvery ?? 1;
  const recordEmpty = config.recordEmptyRuns ?? true;
  const candidateTag = config.policy?.candidateTag ?? 'candidate';

  const store = new InMemoryMemoryStore();
  const ledger = new InMemoryOutcomeLedger();
  const rng = mulberry32(config.seed);

  const effects = new Map(config.lessons.map((l) => [l.id, l.trueEffect]));
  const decided = new Map<string, { outcome: 'promoted' | 'evicted'; reason?: EvictionReason; run: number }>();

  const runScores: number[] = [];
  const gateReports: GateSimulationResult['gateReports'] = [];

  for (let run = 1; run <= config.runs; run++) {
    // Lessons arriving this run enter the candidate pool.
    for (const lesson of config.lessons) {
      if (lesson.arrivesAtRun === run) {
        await store.putFact(makeSimFact(lesson, candidateTag));
      }
    }

    const injected = await retrieveGatedLessons(store, {
      tags: [SIM_TAG],
      ledger,
      ...(config.retrieval ?? {}),
    });

    const liftSum = injected.reduce((s, f) => s + (effects.get(f.id) ?? 0), 0);
    const score = clamp01(base + liftSum + gaussian(rng) * noiseSd);
    runScores.push(score);

    if (injected.length > 0 || recordEmpty) {
      await ledger.recordOutcome({
        run_id: `sim-run-${run}`,
        score,
        fact_ids: injected.map((f) => f.id),
      });
    }

    if (run % gateEvery === 0) {
      const report = await evaluateRetention(store, ledger, config.policy ?? {});
      gateReports.push({ afterRun: run, report });
      for (const p of report.promoted) {
        if (effects.has(p.factId) && !decided.has(p.factId)) {
          decided.set(p.factId, { outcome: 'promoted', run });
        }
      }
      for (const e of report.evicted) {
        if (effects.has(e.factId) && !decided.has(e.factId)) {
          decided.set(e.factId, { outcome: 'evicted', reason: e.reason, run });
        }
      }
    }
  }

  const lessons: SimulatedLessonOutcome[] = config.lessons.map((l) => {
    const d = decided.get(l.id);
    if (!d) return { id: l.id, trueEffect: l.trueEffect, outcome: 'held' };
    return {
      id: l.id,
      trueEffect: l.trueEffect,
      outcome: d.outcome,
      ...(d.reason ? { reason: d.reason } : {}),
      decidedAtRun: d.run,
    };
  });

  return { lessons, runScores: runScores, gateReports: gateReports };
}

// ─── Operating characteristics ──────────────────────────────────────

export interface OperatingCharacteristicsConfig {
  /** True effect sizes to test (negative = harmful lesson). */
  effects: number[];
  /** Run-volume levels. */
  runCounts: number[];
  /** Noise levels (default [0.1]). */
  noiseSds?: number[];
  /** Seeded replicates per grid cell (default 20). */
  replicates?: number;
  /** Base seed (default 1). */
  seed?: number;
  baseScore?: number;
  retrieval?: GateSimulationConfig['retrieval'];
  policy?: Partial<RetentionPolicy>;
  gateEvery?: number;
}

export interface OperatingCharacteristicsRow {
  effect: number;
  runs: number;
  noiseSd: number;
  replicates: number;
  /** Fraction of replicates where the lesson ended promoted. */
  promoteRate: number;
  /** Fraction ended evicted (any reason). */
  evictRate: number;
  /** Fraction evicted as harmful — the "detected as harmful" rate. */
  harmfulEvictRate: number;
  /** Fraction retired as no-lift (maxTrials / maxBaselineRuns). */
  noLiftRate: number;
  /** Fraction still held at the end. */
  heldRate: number;
  /** Promotions of a lesson with effect ≤ 0 (false discovery). */
  falsePromoteRate: number;
  /** Harmful-evictions of a lesson with effect ≥ 0 (false alarm). */
  falseEvictRate: number;
  /** Mean run at which decided replicates reached their verdict. */
  meanDecisionRun: number | null;
}

/**
 * Sweep the gate over a grid of (effect × run volume × noise) cells,
 * one lesson per replicate, and report decision rates per cell.
 *
 * This is the chart that tells you where to trust your policy: a
 * detection-rate curve by run count per effect size, and the
 * false-positive floor at effect 0.
 */
export async function gateOperatingCharacteristics(
  config: OperatingCharacteristicsConfig,
): Promise<OperatingCharacteristicsRow[]> {
  const noiseSds = config.noiseSds ?? [0.1];
  const replicates = config.replicates ?? 20;
  const baseSeed = config.seed ?? 1;
  // Seed streams are baseSeed·10⁶ + cell·10³ + rep — reps beyond 999 would
  // collide with the next cell's stream and silently correlate cells.
  if (replicates > 999) {
    throw new RangeError(
      `gateOperatingCharacteristics: replicates must be <= 999 (got ${replicates})`,
    );
  }

  const rows: OperatingCharacteristicsRow[] = [];
  let cell = 0;

  for (const noiseSd of noiseSds) {
    for (const effect of config.effects) {
      for (const runs of config.runCounts) {
        cell++;
        let promoted = 0;
        let evicted = 0;
        let harmfulEvicted = 0;
        const decisionRuns: number[] = [];

        for (let rep = 0; rep < replicates; rep++) {
          const result = await simulateGate({
            lessons: [{ id: 'lesson-under-test', trueEffect: effect, arrivesAtRun: 1 }],
            runs,
            noiseSd,
            baseScore: config.baseScore,
            seed: baseSeed * 1_000_000 + cell * 1_000 + rep,
            retrieval: config.retrieval,
            policy: config.policy,
            gateEvery: config.gateEvery,
          });
          const lesson = result.lessons[0];
          if (lesson.outcome === 'promoted') promoted++;
          if (lesson.outcome === 'evicted') {
            evicted++;
            if (lesson.reason === 'eval-gate:harmful') harmfulEvicted++;
          }
          if (lesson.decidedAtRun !== undefined) decisionRuns.push(lesson.decidedAtRun);
        }

        rows.push({
          effect,
          runs,
          noiseSd,
          replicates,
          promoteRate: promoted / replicates,
          evictRate: evicted / replicates,
          harmfulEvictRate: harmfulEvicted / replicates,
          noLiftRate: (evicted - harmfulEvicted) / replicates,
          heldRate: (replicates - promoted - evicted) / replicates,
          falsePromoteRate: effect <= 0 ? promoted / replicates : 0,
          falseEvictRate: effect >= 0 ? harmfulEvicted / replicates : 0,
          meanDecisionRun:
            decisionRuns.length === 0
              ? null
              : decisionRuns.reduce((s, v) => s + v, 0) / decisionRuns.length,
        });
      }
    }
  }

  return rows;
}
