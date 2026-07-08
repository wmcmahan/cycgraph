/**
 * Runner Type Definitions
 *
 * Configuration, result, and reporting types for the eval runner.
 *
 * @module runner/types
 */

import type { SuiteName } from '../dataset/types.js';

// ─── Run Configuration ─────────────────────────────────────────────

/** Execution mode determines which provider and concurrency settings to use. */
export type EvalMode = 'local' | 'ci';

/** Configuration for a single eval run. */
export interface EvalRunConfig {
  /** Execution mode: 'local' (Ollama) or 'ci' (GPT-4o). */
  mode: EvalMode;

  /** Suite names to run. If omitted, all suites are executed. */
  suites?: SuiteName[];

  /** Override the default max concurrency for this run. */
  maxConcurrency?: number;

  /** Override the default Semantic Drift ceiling (default: 5.0). */
  driftCeiling?: number;

  /**
   * Number of independent samples to collect for the semantic track.
   * When > 1, each test is run that many times and the majority result
   * is taken. Distinguishes "flaky failure" (mixed samples) from "drift
   * failure" (stable failure). Defaults to 1 in local mode, 3 in ci.
   */
  samples?: number;

  /**
   * Skip the semantic (LLM) track. Useful for PR-time runs where only
   * library/deterministic regressions need to be gated.
   */
  deterministicOnly?: boolean;

  /**
   * Model name passed to the orchestrator SUT. Ignored for memory and
   * context-engine suites (those are deterministic library calls).
   * Defaults to `claude-sonnet-4-6` — the same model the
   * recording script uses.
   */
  sutModel?: string;

  /**
   * Compare this run's result against the prior baseline in
   * `golden/baselines/main-latest.json`. When true, the runner
   * persists a new baseline on a passing run and reports any
   * baseline regressions in the result.
   */
  baseline?: boolean;

  /**
   * Override the noise floor for baseline comparison (percentage points).
   * Smaller deltas are ignored. Defaults to 5.0.
   */
  baselineNoiseFloor?: number;

  /** Optional short git SHA to record with a new baseline snapshot. */
  commit?: string;
}

// ─── Drift Report ──────────────────────────────────────────────────

/** Per-suite drift breakdown. */
export interface SuiteDriftSummary {
  suiteName: string;
  totalTests: number;
  zodFailures: number;
  semanticFailures: number;
  deterministicFailures: number;
  /**
   * Number of tests that drifted — i.e. failed in AT LEAST ONE category. A
   * test failing in several categories counts once, so `driftedTests` is the
   * numerator of {@link driftPercent} (bounded by `totalTests`). The per-
   * category counts above are for reporting only.
   */
  driftedTests: number;
  driftPercent: number;
}

/**
 * Aggregate Semantic Drift report across all suites.
 *
 * `aggregatePercent` is the gate metric — if >= driftCeiling (default 5.0),
 * the eval run fails and the PR is blocked.
 */
export interface DriftReport {
  /** Aggregate drift percentage across all suites. */
  aggregatePercent: number;

  /** Per-suite breakdown. */
  perSuite: Record<string, SuiteDriftSummary>;

  /** Whether the run passed the drift ceiling gate. */
  passed: boolean;
}

// ─── Eval Result ───────────────────────────────────────────────────

/** A suite that failed to load. Surfaced so a CI failure looks like a failure. */
export interface SuiteLoadError {
  suite: string;
  phase: 'deterministic' | 'semantic';
  error: string;
}

/** Complete result of an eval run. */
export interface EvalResult {
  /** Computed drift report with gate pass/fail. */
  drift: DriftReport;

  /** Raw per-test results across both tracks. */
  raw: unknown;

  /**
   * Any suites that failed to load. Non-empty values should be treated as a
   * gate failure by callers — a missing suite produces zero tests and would
   * otherwise pass the drift gate trivially.
   */
  suiteLoadErrors: SuiteLoadError[];

  /**
   * Baseline comparison result, when the run was configured with
   * `baseline: true`. `undefined` when baseline comparison was not
   * requested.
   */
  baselineDelta?: import('../baseline/types.js').BaselineDelta;

  /**
   * Tests that produced inconsistent pass/fail outcomes across samples.
   * Empty when `samples: 1`. Populated only when `samples > 1` and at
   * least one test was unstable.
   */
  flakyTests?: Array<{ suite: string; passRate: number; samples: number }>;
}
