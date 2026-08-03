/**
 * SUT-Driven Semantic Track
 *
 * For each test in each suite:
 *
 *   1. Resolve the linked trajectory from the golden dataset
 *   2. Dispatch through the appropriate SUT (real library / orchestrator)
 *      to produce a real `actualOutput` for the commit under test
 *   3. Apply structural assertions to the observed tool calls when the
 *      trajectory has expected tool calls
 *   4. Apply each declared rubric metric via `evaluateMetricMultiSample`
 *      using the provider's `callJudge`
 *   5. Aggregate per-test results into the shared `TestCaseResults` shape
 *
 * Every semantic test gets an `actualOutput` produced by the code at the
 * current commit, so drift is attributable to changes you made.
 *
 * @module runner/sut-semantic-track
 */

import { loadGoldenTrajectories } from '../dataset/loader.js';
import { planForTrajectory } from '../sut/recording-planner.js';
import { runSutDispatch } from '../sut/dispatch.js';
import { assertTrajectoryStructure } from '../assertions/zod-structural.js';
import { evaluateMetricMultiSample } from './multi-sample.js';
import type { EvalProvider } from '../providers/types.js';
import type { SuiteName, GoldenTrajectory } from '../dataset/types.js';
import type {
  SutSuiteConfig,
  SutSuiteTestCase,
} from '../suites/sut-contract.js';
import type { TestCaseResults } from '../assertions/drift-calculator.js';
import type {
  ZodStructuralResult,
  SemanticJudgeResult,
} from '../assertions/types.js';
import type { EvalResult } from './types.js';

/** Options for one SUT-driven track invocation. */
export interface RunSutSemanticOptions {
  /** Judge provider — only `callJudge` is consumed here. */
  provider: EvalProvider;
  /** Suite configs with associated suite names. */
  suiteConfigs: Array<{ suite: SuiteName; config: SutSuiteConfig }>;
  /** Number of judge samples per metric (default: provider's mode default). */
  samples: number;
  /** Model identifier passed to the orchestrator SUT (ignored for other suites). */
  model: string;
}

/** Output of the SUT-driven track. */
export interface SutSemanticOutput {
  results: TestCaseResults[];
  flakyTests?: EvalResult['flakyTests'];
}

/**
 * Run the SUT-driven semantic track end-to-end. Returns `TestCaseResults`
 * shaped identically to the deterministic track so `computeDrift()` can
 * aggregate both into one drift report.
 */
export async function runSutSemanticTrack(
  opts: RunSutSemanticOptions,
): Promise<SutSemanticOutput> {
  const results: TestCaseResults[] = [];
  const flakyTests: NonNullable<EvalResult['flakyTests']> = [];

  for (const { suite, config } of opts.suiteConfigs) {
    const trajectories = safeLoadTrajectories(suite);
    const trajectoryById = new Map(trajectories.map(t => [t.id, t]));

    for (const test of config.tests) {
      const trajectory = trajectoryById.get(test.trajectoryId);
      if (!trajectory) {
        results.push(missingTrajectoryResult(suite, test));
        continue;
      }

      const testResult = await runOneTest({
        suite,
        test,
        trajectory,
        provider: opts.provider,
        samples: opts.samples,
        model: opts.model,
      });
      results.push(testResult.result);
      if (testResult.flaky) {
        flakyTests.push(testResult.flaky);
      }
    }
  }

  return {
    results,
    flakyTests: flakyTests.length > 0 ? flakyTests : undefined,
  };
}

// ─── Per-Test Loop ─────────────────────────────────────────────────

interface OneTestOptions {
  suite: SuiteName;
  test: SutSuiteTestCase;
  trajectory: GoldenTrajectory;
  provider: EvalProvider;
  samples: number;
  model: string;
}

interface OneTestResult {
  result: TestCaseResults;
  flaky?: NonNullable<EvalResult['flakyTests']>[number];
}

async function runOneTest(opts: OneTestOptions): Promise<OneTestResult> {
  // 1. Plan + dispatch the trajectory through its SUT.
  const plan = planForTrajectory(opts.suite, opts.trajectory);

  if (!plan.supported) {
    return {
      result: unsupportedResult(opts.suite, plan.skipReason ?? 'unsupported trajectory'),
    };
  }

  const sutResult = await runSutDispatch({
    suite: opts.suite,
    plan,
    model: opts.model,
  });

  if (sutResult.status !== 'completed') {
    return {
      result: sutFailedResult(opts.suite, sutResult.error ?? sutResult.status),
    };
  }

  // 2. Structural assertions on observed tool calls (when applicable).
  const wantsStructural = opts.test.structuralAssertions !== false;
  const expectedToolCalls = opts.trajectory.expectedToolCalls;
  const zodResults: ZodStructuralResult[] =
    wantsStructural && expectedToolCalls && expectedToolCalls.length > 0
      ? assertTrajectoryStructure(
          sutResult.toolCalls.map(c => ({ toolName: c.toolName, args: c.args })),
          expectedToolCalls,
        )
      : [];

  // 3. Semantic metrics via the multi-sample judge.
  const expectedOutput = typeof opts.trajectory.expectedOutput === 'string'
    ? opts.trajectory.expectedOutput
    : JSON.stringify(opts.trajectory.expectedOutput);

  const callJudge = (prompt: string) => opts.provider.callJudge(prompt);

  const semanticResults: SemanticJudgeResult[] = [];
  let flakyAggregate = false;
  let totalSamples = 0;
  let passingSamples = 0;

  for (const metricSpec of opts.test.metrics) {
    const multi = await evaluateMetricMultiSample(
      {
        input: opts.trajectory.input,
        actualOutput: sutResult.output,
        expectedOutput,
      },
      metricSpec.metric,
      callJudge,
      {
        samples: opts.samples,
        threshold: metricSpec.threshold,
      },
    );

    semanticResults.push({
      passed: multi.passed,
      score: multi.median,
      reasoning: multi.reasoning,
      metric: multi.metric,
    });

    // Track stability for the flaky-tests rollup. A metric that's unstable
    // counts as flaky for the whole test; if any metric is unstable the
    // test is reported as flaky distinct from drift.
    if (!multi.stable && multi.samples.length > 1) {
      flakyAggregate = true;
    }
    totalSamples += multi.samples.length;
    passingSamples += multi.samples.filter(s => s >= (metricSpec.threshold ?? 0.8)).length;
  }

  // Empty metrics list => no semantic assertion. Still produce a single
  // synthetic result so the drift calculator has something to work with.
  const semanticForResult = semanticResults.length > 0 ? semanticResults : [
    {
      passed: true,
      score: 1,
      reasoning: 'No semantic metrics declared for this test.',
      metric: 'no-op',
    } satisfies SemanticJudgeResult,
  ];

  const result: TestCaseResults = {
    suite: opts.suite,
    zodResults,
    semanticResults: semanticForResult,
  };

  const flaky = flakyAggregate
    ? {
        suite: opts.suite,
        passRate: totalSamples > 0 ? passingSamples / totalSamples : 0,
        samples: totalSamples,
      }
    : undefined;

  return { result, flaky };
}

// ─── Helpers ───────────────────────────────────────────────────────

function safeLoadTrajectories(suite: SuiteName): GoldenTrajectory[] {
  try {
    return loadGoldenTrajectories(suite);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[eval] Failed to load goldens for suite "${suite}": ${message}`);
    return [];
  }
}

function missingTrajectoryResult(
  suite: SuiteName,
  test: SutSuiteTestCase,
): TestCaseResults {
  return {
    suite,
    zodResults: [{
      passed: false,
      toolName: 'sut_semantic_track',
      missingParams: [],
      typeMismatches: [{
        param: '__trajectoryId__',
        expected: 'a trajectory in the golden dataset',
        received: `not found: ${test.trajectoryId}`,
      }],
    }],
    semanticResults: [{
      passed: false,
      score: 0,
      reasoning: `Trajectory ${test.trajectoryId} referenced by suite test was not found in the golden dataset.`,
      metric: 'sut_lookup',
    }],
  };
}

function unsupportedResult(suite: SuiteName, reason: string): TestCaseResults {
  return {
    suite,
    zodResults: [],
    semanticResults: [{
      passed: false,
      score: 0,
      reasoning: `SUT does not yet support this trajectory: ${reason}`,
      metric: 'sut_unsupported',
    }],
  };
}

function sutFailedResult(suite: SuiteName, error: string): TestCaseResults {
  return {
    suite,
    zodResults: [{
      passed: false,
      toolName: 'sut_run',
      missingParams: [],
      typeMismatches: [{
        param: '__sut__',
        expected: 'completed',
        received: 'failed',
      }],
    }],
    semanticResults: [{
      passed: false,
      score: 0,
      reasoning: `SUT failed before semantic evaluation could run: ${error}`,
      metric: 'sut_dispatch',
    }],
  };
}
