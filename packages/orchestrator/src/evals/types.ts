/**
 * Eval Type Definitions
 *
 * Defines the assertion types, eval case structure, result interfaces,
 * and reporting types for the evaluation framework.
 *
 * @module evals/types
 */

import type { Graph } from '../graph/graph.js';

// ─── Assertion Types ────────────────────────────────────────────────

/**
 * Union of all supported eval assertion types.
 *
 * Each variant is checked by {@link checkAssertion} against the final
 * workflow state after execution.
 */
export type EvalAssertion =
  | { type: 'status_equals'; /** Expected workflow status. */ expected: string }
  | { type: 'memory_contains'; /** Key that must exist in memory. */ key: string }
  | {
    type: 'memory_not_empty';
    /** Key that must exist AND carry something.*/
    key: string;
  }
  | {
    type: 'memory_matches';
    /** Memory key to inspect. */
    key: string;
    /** Regex pattern (used when `mode` is `'regex'`). */
    pattern: string;
    /** Comparison strategy. */
    mode: 'exact' | 'contains' | 'regex';
    /** Expected value (used when `mode` is `'exact'` or `'contains'`). */
    expected?: unknown;
  }
  | {
    type: 'llm_judge';
    /** Evaluation criteria passed to the LLM judge. */
    criteria: string;
    /** Minimum passing score (0–1). */
    threshold: number;
    /** ID of the evaluator agent to use. */
    evaluator_agent_id: string;
  }
  | { type: 'node_visited'; /** Node ID that must appear in `visited_nodes`. */ node_id: string }
  | { type: 'token_budget_respected' };

// ─── Result Interfaces ──────────────────────────────────────────────

/** Result of a single assertion check. */
export interface AssertionResult {
  /** The assertion that was checked. */
  assertion: EvalAssertion;
  /** Whether the assertion passed. */
  passed: boolean;
  /** The actual value observed (for diagnostics). */
  actual?: unknown;
  /** Human-readable failure message (`undefined` on pass). */
  message?: string;
}

/** Result of running a single eval case. */
export interface EvalCaseResult {
  /** Name of the eval case. */
  name: string;
  /** Whether all assertions passed. */
  passed: boolean;
  /** Fraction of assertions that passed (0.0–1.0). */
  score: number;
  /** Wall-clock duration in milliseconds. */
  duration_ms: number;
  /** Individual assertion results. */
  assertions: AssertionResult[];
  /** Error message if the workflow crashed before assertions could run. */
  error?: string;
}

// ─── Suite / Report ─────────────────────────────────────────────────

/** A single eval test case. */
export interface EvalCase {
  /** Human-readable case name. */
  name: string;
  /** The graph to execute. */
  graph: Graph;
  /** Input data seeded into initial workflow memory. */
  input: Record<string, unknown>;
  /** Assertions to check against the final state. */
  assertions: EvalAssertion[];
  /** Optional agent config overrides (reserved for future use). */
  agent_configs?: Record<string, unknown>;
  /** Workflow timeout in milliseconds (default: 60 000). */
  timeout_ms?: number;
}

/** Aggregate report from running an entire eval suite. */
export interface EvalReport {
  /** Name of the suite. */
  suite_name: string;
  /** Per-case results. */
  cases: EvalCaseResult[];
  /** Mean score across all cases (0.0–1.0). */
  overall_score: number;
  /** Total number of cases. */
  total: number;
  /** Number of fully passing cases. */
  passed: number;
  /** Number of cases with at least one failure. */
  failed: number;
  /** Total wall-clock duration in milliseconds. */
  duration_ms: number;
}

/** A collection of eval cases to run together. */
export interface EvalSuite {
  /** Human-readable suite name. */
  name: string;
  /** The cases in this suite. */
  cases: EvalCase[];
}
