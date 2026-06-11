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
 * `include_invalidated`), but the signal remains correlational.
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
  fact_id: string;
  /** Number of runs the fact was injected into. */
  trials: number;
  /** Mean outcome score of those runs. */
  mean_score: number;
}

/** Aggregate over a set of runs, used as the comparison baseline. */
export interface OutcomeBaseline {
  /** Number of runs in the baseline. */
  runs: number;
  /** Mean outcome score across them (0 when `runs` is 0). */
  mean_score: number;
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
    let trials = 0;
    let total = 0;
    for (const outcome of this.outcomes.values()) {
      if (outcome.fact_ids.includes(factId)) {
        trials++;
        total += outcome.score;
      }
    }
    if (trials === 0) return null;
    return { fact_id: factId, trials, mean_score: total / trials };
  }

  async listFactStats(): Promise<FactStats[]> {
    const totals = new Map<string, { trials: number; total: number }>();
    for (const outcome of this.outcomes.values()) {
      for (const factId of new Set(outcome.fact_ids)) {
        const entry = totals.get(factId) ?? { trials: 0, total: 0 };
        entry.trials++;
        entry.total += outcome.score;
        totals.set(factId, entry);
      }
    }
    return [...totals.entries()]
      .map(([fact_id, { trials, total }]) => ({ fact_id, trials, mean_score: total / trials }))
      .sort((a, b) => a.fact_id.localeCompare(b.fact_id));
  }

  async getBaseline(excludeFactId?: string): Promise<OutcomeBaseline> {
    let runs = 0;
    let total = 0;
    for (const outcome of this.outcomes.values()) {
      if (excludeFactId !== undefined && outcome.fact_ids.includes(excludeFactId)) continue;
      runs++;
      total += outcome.score;
    }
    return { runs, mean_score: runs === 0 ? 0 : total / runs };
  }

  async clear(): Promise<void> {
    this.outcomes.clear();
  }
}
