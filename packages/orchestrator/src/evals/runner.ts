/**
 * Eval Runner
 *
 * Executes eval suites by running each case's graph, then checking
 * its assertions against the terminal workflow state. Produces an
 * {@link EvalReport} with per-case results and aggregate scores.
 *
 * Cases are run sequentially to avoid resource contention when
 * multiple cases hit the same LLM provider.
 *
 * @module evals/runner
 */

import { v4 as uuidv4 } from 'uuid';
import { GraphRunner } from '../runner/graph-runner.js';
import type { WorkflowState } from '../types/state.js';
import { checkAssertion } from './assertions.js';
import type { EvalSuite, EvalCase, EvalCaseResult, EvalReport } from './types.js';

/**
 * Run a single eval case: execute the graph, then check assertions.
 *
 * @param evalCase - The case to run.
 * @returns Per-case result with score, assertion details, and timing.
 */
async function runCase(evalCase: EvalCase): Promise<EvalCaseResult> {
  const startTime = Date.now();

  try {
    const initialState = buildInitialState(evalCase);
    const runner = new GraphRunner(evalCase.graph, initialState);
    const finalState = await runner.run();

    const assertionResults = await Promise.all(
      evalCase.assertions.map(a => checkAssertion(a, finalState))
    );

    const passedCount = assertionResults.filter(r => r.passed).length;
    const score = evalCase.assertions.length > 0 ? passedCount / evalCase.assertions.length : 1.0;

    return {
      name: evalCase.name,
      passed: assertionResults.every(r => r.passed),
      score,
      duration_ms: Date.now() - startTime,
      assertions: assertionResults,
    };
  } catch (error) {
    return {
      name: evalCase.name,
      passed: false,
      score: 0,
      duration_ms: Date.now() - startTime,
      assertions: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Run an entire eval suite sequentially and produce an aggregate report.
 *
 * @param suite - The suite containing one or more eval cases.
 * @returns An {@link EvalReport} with per-case and aggregate results.
 */
export async function runEval(suite: EvalSuite): Promise<EvalReport> {
  const startTime = Date.now();
  const results: EvalCaseResult[] = [];

  for (const evalCase of suite.cases) {
    const result = await runCase(evalCase);
    results.push(result);
  }

  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  const overall_score = results.length > 0
    ? results.reduce((sum, r) => sum + r.score, 0) / results.length
    : 0;

  return {
    suite_name: suite.name,
    cases: results,
    overall_score,
    total: results.length,
    passed,
    failed,
    duration_ms: Date.now() - startTime,
  };
}

/**
 * Build the initial {@link WorkflowState} for an eval case.
 *
 * Seeds workflow memory with the case's `input` data, extracts
 * `goal`, `constraints`, and `max_token_budget` if provided
 * as top-level input fields.
 *
 * @param evalCase - The eval case to build state for.
 * @returns A fresh workflow state ready for execution.
 */
function buildInitialState(evalCase: EvalCase): WorkflowState {
  const goal = typeof evalCase.input.goal === 'string'
    ? evalCase.input.goal
    : 'Eval case execution';

  const constraints = Array.isArray(evalCase.input.constraints)
    ? evalCase.input.constraints.filter((c): c is string => typeof c === 'string')
    : [];

  const maxTokenBudget = typeof evalCase.input.max_token_budget === 'number'
    ? evalCase.input.max_token_budget
    : undefined;

  return {
    state_schema_version: 1,
    workflow_id: evalCase.graph.id,
    run_id: uuidv4(),
    created_at: new Date(),
    updated_at: new Date(),
    goal,
    constraints,
    status: 'pending',
    current_node: undefined,
    iteration_count: 0,
    retry_count: 0,
    max_retries: 3,
    last_error: undefined,
    waiting_for: undefined,
    waiting_since: undefined,
    waiting_timeout_at: undefined,
    started_at: undefined,
    max_execution_time_ms: evalCase.timeout_ms || 60000,
    memory: evalCase.input,
    total_tokens_used: 0,
    total_cost_usd: 0,
    max_token_budget: maxTokenBudget,
    visited_nodes: [],
    max_iterations: 50,
    compensation_stack: [],
    supervisor_history: [],
    memory_drops: [],
    _cost_alert_thresholds_fired: [],
  };
}
