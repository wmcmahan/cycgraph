/**
 * Drift Calculator
 *
 * Aggregates per-test zod structural and semantic judge results
 * into a single Semantic Drift % metric per suite and overall.
 *
 * Formula: Drift % = driftedTests / totalTests * 100, where a test is
 * "drifted" if it failed in AT LEAST ONE category (zod / semantic /
 * deterministic). A test failing several ways counts once — so drift is a true
 * fraction of tests in [0, 100], not a sum of failure events that can exceed
 * 100% (e.g. one test failing all three categories used to score 300%).
 *
 * @module assertions/drift-calculator
 */

import type { DriftReport, SuiteDriftSummary } from '../runner/types.js';
import type { ZodStructuralResult } from './types.js';
import type { SemanticJudgeResult } from './types.js';
import type { DeterministicResult } from './deterministic.js';

/** Results for a single test case across all assertion types. */
export interface TestCaseResults {
  /** Suite this test belongs to. */
  suite: string;

  /** Zod structural results for this test's tool calls. Empty if no tool calls expected. */
  zodResults: ZodStructuralResult[];

  /** Semantic judge results for this test. Empty if semantic eval was skipped. */
  semanticResults: SemanticJudgeResult[];

  /** Deterministic assertion results. Empty if deterministic eval was skipped. */
  deterministicResults?: DeterministicResult[];
}

/**
 * Computes the aggregate Semantic Drift report from per-test results.
 *
 * A test case "fails" if:
 * - Any zod structural assertion fails (wrong type, missing param)
 * - Any semantic score falls below the threshold
 *
 * @param testResults - Results from all test cases across all suites.
 * @param driftCeiling - Maximum allowable drift % (default: 5.0).
 * @returns Drift report with aggregate and per-suite breakdowns.
 */
export function computeDrift(
  testResults: TestCaseResults[],
  driftCeiling: number = 5.0,
): DriftReport {
  if (testResults.length === 0) {
    return {
      aggregatePercent: 0,
      perSuite: {},
      passed: true,
    };
  }

  // Group by suite
  const bySuite = new Map<string, TestCaseResults[]>();
  for (const result of testResults) {
    const existing = bySuite.get(result.suite) ?? [];
    existing.push(result);
    bySuite.set(result.suite, existing);
  }

  // Compute per-suite drift
  const perSuite: Record<string, SuiteDriftSummary> = {};
  let totalTests = 0;
  let totalDriftedTests = 0;

  for (const [suiteName, suiteResults] of bySuite) {
    const summary = computeSuiteDrift(suiteName, suiteResults);
    perSuite[suiteName] = summary;
    totalTests += summary.totalTests;
    totalDriftedTests += summary.driftedTests;
  }

  const aggregatePercent = totalTests > 0
    ? (totalDriftedTests / totalTests) * 100
    : 0;

  return {
    aggregatePercent,
    perSuite,
    passed: aggregatePercent < driftCeiling,
  };
}

/**
 * Computes drift for a single suite.
 */
function computeSuiteDrift(
  suiteName: string,
  results: TestCaseResults[],
): SuiteDriftSummary {
  let zodFailures = 0;
  let semanticFailures = 0;
  let deterministicFailures = 0;
  let driftedTests = 0;

  for (const result of results) {
    const zodFailed = result.zodResults.some(r => !r.passed);
    const semanticFailed = result.semanticResults.some(r => !r.passed);
    const deterministicFailed = result.deterministicResults?.some(r => !r.passed) ?? false;

    if (zodFailed) zodFailures++;
    if (semanticFailed) semanticFailures++;
    if (deterministicFailed) deterministicFailures++;
    // A test is drifted if it failed in ANY category — counted once.
    if (zodFailed || semanticFailed || deterministicFailed) driftedTests++;
  }

  const totalTests = results.length;
  const driftPercent = totalTests > 0
    ? (driftedTests / totalTests) * 100
    : 0;

  return {
    suiteName,
    totalTests,
    zodFailures,
    semanticFailures,
    deterministicFailures,
    driftedTests,
    driftPercent,
  };
}
