/**
 * Outcome Ledger
 *
 * Records the outcome score of workflow runs together with the memory
 * facts that were injected into them, accumulating the per-fact evidence
 * that drives eval-gated retention (see `retention-gate.ts`).
 *
 * The ledger is deliberately store-agnostic and async-only so a
 * database-backed implementation (e.g. a Drizzle `memory_run_outcomes`
 * table) can be added later without an interface change.
 *
 * Statistical caveat: per-fact means versus a leave-one-out baseline are
 * a heuristic, not causal inference. Facts are co-injected, and run
 * difficulty varies — the retention gate mitigates this with minimum
 * trial counts, margins, and soft-delete eviction (recoverable via
 * `includeInvalidated`), but the signal remains correlational.
 *
 * @module consolidation/outcome-ledger
 */

import { z } from 'zod';

/**
 * One scored workflow run. `fact_ids` are the memory facts that were
 * injected into prompts during the run (from the orchestrator's lesson
 * provenance registry); `score` is the caller's outcome metric
 * normalised to [0, 1].
 */
export const RunOutcomeSchema = z.object({
  /** Workflow run identifier. Re-recording the same run replaces it. */
  run_id: z.string().min(1),
  /** Outcome score normalised to [0, 1]. */
  score: z.number().min(0).max(1),
  /** IDs of facts injected into the run's prompts. */
  fact_ids: z.array(z.string()).default([]),
  /** When the outcome was recorded (defaults to now). */
  recorded_at: z.coerce.date().optional(),
});

export type RunOutcome = z.infer<typeof RunOutcomeSchema>;

/** Aggregate evidence for one fact across all recorded runs. */
export interface FactStats {
  factId: string;
  /** Number of runs the fact was injected into. */
  trials: number;
  /** Mean outcome score of those runs. */
  meanScore: number;
  /**
   * Sample variance of those run scores (n−1 denominator).
   * `undefined` when `trials < 2` — variance needs a degree of freedom.
   * Consumed by the retention gate's `inference` decision rule.
   */
  variance?: number;
}

/** Aggregate over a set of runs, used as the comparison baseline. */
export interface OutcomeBaseline {
  /** Number of runs in the baseline. */
  runs: number;
  /** Mean outcome score across them (0 when `runs` is 0). */
  meanScore: number;
  /** Sample variance (n−1 denominator); `undefined` when `runs < 2`. */
  variance?: number;
}

/**
 * Accumulates run outcomes and answers the per-fact statistics queries
 * the retention gate needs.
 */
export interface OutcomeLedger {
  /**
   * Record (or re-record) a run outcome. Idempotent on `run_id`:
   * recording the same run twice replaces the earlier entry, so callers
   * can safely retry.
   */
  recordOutcome(outcome: RunOutcome): Promise<void>;

  /** Stats for one fact, or `null` if it appeared in no recorded run. */
  getFactStats(factId: string): Promise<FactStats | null>;

  /**
   * Batch variant of {@link getFactStats}: stats for each requested fact
   * that appeared in at least one run (missing IDs absent from the Map).
   * Optional — consumers fall back to per-ID getFactStats. DB-backed
   * ledgers should implement it: gated retrieval queries trial counts for
   * every candidate on every prompt build, and per-ID lookups are an N+1
   * round-trip against Postgres.
   */
  getFactStatsBatch?(factIds: string[]): Promise<Map<string, FactStats>>;

  /** Stats for every fact that appeared in at least one recorded run. */
  listFactStats(): Promise<FactStats[]>;

  /**
   * Mean score over recorded runs. When `excludeFactId` is given, only
   * runs that did NOT include that fact are counted (leave-one-out
   * baseline) — this blunts the "one prolific fact drags the global
   * mean toward itself" confound.
   */
  getBaseline(excludeFactId?: string): Promise<OutcomeBaseline>;

  /** Remove all recorded outcomes (for test teardown). */
  clear(): Promise<void>;
}

/** Mean + sample variance (n−1) of a score list. */
function summarize(scores: number[]): { mean: number; variance?: number } {
  const n = scores.length;
  if (n === 0) return { mean: 0 };
  const mean = scores.reduce((s, v) => s + v, 0) / n;
  if (n < 2) return { mean };
  const ss = scores.reduce((s, v) => s + (v - mean) ** 2, 0);
  return { mean, variance: ss / (n - 1) };
}

/** In-memory `OutcomeLedger`. Suitable for single-process workflows and tests. */
export class InMemoryOutcomeLedger implements OutcomeLedger {
  private readonly outcomes = new Map<string, RunOutcome>();

  async recordOutcome(outcome: RunOutcome): Promise<void> {
    const parsed = RunOutcomeSchema.parse(outcome);
    this.outcomes.set(parsed.run_id, {
      ...parsed,
      recorded_at: parsed.recorded_at ?? new Date(),
    });
  }

  async getFactStats(factId: string): Promise<FactStats | null> {
    const scores: number[] = [];
    for (const outcome of this.outcomes.values()) {
      if (outcome.fact_ids.includes(factId)) scores.push(outcome.score);
    }
    if (scores.length === 0) return null;
    const { mean, variance } = summarize(scores);
    return {
      factId: factId,
      trials: scores.length,
      meanScore: mean,
      ...(variance !== undefined ? { variance } : {}),
    };
  }

  async getFactStatsBatch(factIds: string[]): Promise<Map<string, FactStats>> {
    const wanted = new Set(factIds);
    const byFact = new Map<string, number[]>();
    for (const outcome of this.outcomes.values()) {
      for (const factId of new Set(outcome.fact_ids)) {
        if (!wanted.has(factId)) continue;
        const scores = byFact.get(factId) ?? [];
        scores.push(outcome.score);
        byFact.set(factId, scores);
      }
    }
    const result = new Map<string, FactStats>();
    for (const [factId, scores] of byFact) {
      const { mean, variance } = summarize(scores);
      result.set(factId, {
        factId,
        trials: scores.length,
        meanScore: mean,
        ...(variance !== undefined ? { variance } : {}),
      });
    }
    return result;
  }

  async listFactStats(): Promise<FactStats[]> {
    const byFact = new Map<string, number[]>();
    for (const outcome of this.outcomes.values()) {
      for (const factId of new Set(outcome.fact_ids)) {
        const scores = byFact.get(factId) ?? [];
        scores.push(outcome.score);
        byFact.set(factId, scores);
      }
    }
    return [...byFact.entries()]
      .map(([factId, scores]) => {
        const { mean, variance } = summarize(scores);
        return {
          factId,
          trials: scores.length,
          meanScore: mean,
          ...(variance !== undefined ? { variance } : {}),
        };
      })
      .sort((a, b) => a.factId.localeCompare(b.factId));
  }

  async getBaseline(excludeFactId?: string): Promise<OutcomeBaseline> {
    const scores: number[] = [];
    for (const outcome of this.outcomes.values()) {
      if (excludeFactId !== undefined && outcome.fact_ids.includes(excludeFactId)) continue;
      scores.push(outcome.score);
    }
    const { mean, variance } = summarize(scores);
    return {
      runs: scores.length,
      meanScore: mean,
      ...(variance !== undefined ? { variance } : {}),
    };
  }

  async clear(): Promise<void> {
    this.outcomes.clear();
  }
}
