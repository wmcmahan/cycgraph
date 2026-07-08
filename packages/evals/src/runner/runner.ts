/**
 * Eval Runner
 *
 * Top-level entry point for the eval harness. Runs the deterministic
 * track in-process and the SUT-driven semantic track against the real
 * `@cycgraph/*` packages at the current commit. Computes drift,
 * optionally compares against a persisted baseline, and gates on the
 * result.
 *
 * Usage:
 *   npx tsx src/runner/runner.ts --mode local
 *   npx tsx src/runner/runner.ts --mode ci
 *   npx tsx src/runner/runner.ts --mode local --suite memory
 *   npx tsx src/runner/runner.ts --deterministic-only
 *   npx tsx src/runner/runner.ts --mode ci --samples 3 --baseline
 *
 * Exit codes:
 *   0 — drift gate passed, no baseline regression
 *   1 — drift gate failed OR a suite failed to load
 *   2 — baseline regression detected but drift gate passed
 *
 * @module runner/runner
 */

import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createOllamaProvider } from '../providers/ollama.js';
import { createOpenAIProvider } from '../providers/openai.js';
import { computeDrift } from '../assertions/drift-calculator.js';
import { formatReport } from './reporter.js';
import { runSutSemanticTrack } from './sut-semantic-track.js';
import type { SutSemanticOutput } from './sut-semantic-track.js';
import {
  snapshotFromDrift,
  writeBaseline,
  loadBaseline,
  compareBaseline,
  formatBaselineDelta,
} from '../baseline/index.js';
import type { EvalRunConfig, EvalResult, DriftReport } from './types.js';
import type { EvalProvider } from '../providers/types.js';
import type { SuiteName } from '../dataset/types.js';
import type { TestCaseResults } from '../assertions/drift-calculator.js';
import type { SutSuiteConfig } from '../suites/sut-contract.js';

/** Shape of a suite module's deterministic entry point. */
interface DeterministicSuiteModule {
  runDeterministic?: () => Promise<TestCaseResults[]>;
}

// ─── Provider Selection ────────────────────────────────────────────

function selectProvider(config: EvalRunConfig): EvalProvider {
  if (config.mode === 'ci') {
    return createOpenAIProvider();
  }
  return createOllamaProvider();
}

/** Default sample count when the caller doesn't override it. */
function defaultSamples(mode: 'local' | 'ci'): number {
  return mode === 'ci' ? 3 : 1;
}

// ─── Main Runner ───────────────────────────────────────────────────

/**
 * Run the eval harness.
 *
 * @param config - Run configuration. See {@link EvalRunConfig}.
 * @returns Eval result with drift report, optional baseline delta, and
 *          any suite-load errors.
 */
export async function runEvals(config: EvalRunConfig): Promise<EvalResult> {
  const driftCeiling = config.driftCeiling
    ?? parseFloat(process.env['EVAL_DRIFT_CEILING'] ?? '5.0');
  const samples = config.samples ?? defaultSamples(config.mode);
  const suitesToLoad = config.suites
    ?? (['context-engine', 'memory', 'orchestrator'] as SuiteName[]);

  const suiteLoadErrors: Array<{
    suite: string;
    phase: 'deterministic' | 'semantic';
    error: string;
  }> = [];

  // ─── Deterministic Track ─────────────────────────────────────────
  // Runs in-process; no LLM. Cheap, fast, free.
  const deterministicResults = await runDeterministicTrack(
    suitesToLoad,
    suiteLoadErrors,
  );

  // ─── SUT-Driven Semantic Track ───────────────────────────────────
  let semanticResults: TestCaseResults[] = [];
  let flakyTests: EvalResult['flakyTests'] = undefined;

  if (!config.deterministicOnly) {
    const provider = selectProvider(config);
    const sut = await runSemanticTrackForSuites({
      provider,
      suiteNames: suitesToLoad,
      samples,
      model: config.sutModel ?? 'claude-sonnet-4-6',
    });
    semanticResults = sut.results;
    flakyTests = sut.flakyTests;
  }

  // ─── Drift Computation ───────────────────────────────────────────
  const allResults = [...deterministicResults, ...semanticResults];
  const drift = computeDrift(allResults, driftCeiling);

  // ─── Baseline (optional) ─────────────────────────────────────────
  let baselineDelta: EvalResult['baselineDelta'] = undefined;
  if (config.baseline) {
    baselineDelta = await runBaselineComparison({
      drift,
      driftCeiling,
      mode: config.mode,
      commit: config.commit,
      noiseFloor: config.baselineNoiseFloor,
      persistOnPass: drift.passed,
    });
  }

  // ─── Reporting ───────────────────────────────────────────────────
  printReport(drift, config.mode, baselineDelta, flakyTests, suiteLoadErrors);

  return { drift, raw: allResults, suiteLoadErrors, baselineDelta, flakyTests };
}

// ─── Static Suite Dispatchers ──────────────────────────────────────

/**
 * Static import map for each suite's deterministic entry point.
 *
 * Importing suites statically (rather than via `await import(path)`) keeps
 * the bundler happy, makes load failures into hard compile-time errors
 * instead of runtime path mistakes, and means vitest can resolve them
 * without special configuration.
 */
async function getDeterministicEntrypoint(
  suiteName: SuiteName,
): Promise<DeterministicSuiteModule | null> {
  switch (suiteName) {
    case 'memory':
      return await import('../suites/memory/suite.js') as DeterministicSuiteModule;
    case 'context-engine':
      return await import('../suites/context-engine/suite.js') as DeterministicSuiteModule;
    case 'integration':
      return await import('../suites/integration/suite.js') as DeterministicSuiteModule;
    case 'orchestrator':
      // Orchestrator's deterministic track is recording-driven; nothing to
      // run in-process. Return null so the loader silently skips.
      return null;
  }
}

/**
 * Static import map for each suite's SUT-driven semantic config.
 * All four suites are expected to implement `buildSutSuite()`.
 */
async function loadSutSuiteConfig(
  suiteName: SuiteName,
): Promise<SutSuiteConfig> {
  switch (suiteName) {
    case 'memory': {
      const mod = await import('../suites/memory/suite.js');
      return mod.buildSutSuite();
    }
    case 'context-engine': {
      const mod = await import('../suites/context-engine/suite.js');
      return mod.buildSutSuite();
    }
    case 'orchestrator': {
      const mod = await import('../suites/orchestrator/suite.js');
      return mod.buildSutSuite();
    }
    case 'integration': {
      const mod = await import('../suites/integration/suite.js');
      return mod.buildSutSuite();
    }
  }
}

// ─── Track Runners ─────────────────────────────────────────────────

async function runDeterministicTrack(
  suiteNames: SuiteName[],
  suiteLoadErrors: Array<{
    suite: string;
    phase: 'deterministic' | 'semantic';
    error: string;
  }>,
): Promise<TestCaseResults[]> {
  const results: TestCaseResults[] = [];

  for (const suiteName of suiteNames) {
    try {
      const mod = await getDeterministicEntrypoint(suiteName);
      if (mod?.runDeterministic) {
        results.push(...(await mod.runDeterministic()));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[eval] Deterministic track for suite "${suiteName}" failed: ${message}`,
      );
      suiteLoadErrors.push({
        suite: suiteName,
        phase: 'deterministic',
        error: message,
      });
    }
  }

  return results;
}

interface SutSuiteRunOptions {
  provider: EvalProvider;
  suiteNames: SuiteName[];
  samples: number;
  model: string;
}

async function runSemanticTrackForSuites(
  opts: SutSuiteRunOptions,
): Promise<SutSemanticOutput> {
  const suiteConfigs: Array<{ suite: SuiteName; config: SutSuiteConfig }> = [];

  for (const suite of opts.suiteNames) {
    suiteConfigs.push({ suite, config: await loadSutSuiteConfig(suite) });
  }

  if (suiteConfigs.length === 0) {
    return { results: [], flakyTests: undefined };
  }

  return runSutSemanticTrack({
    provider: opts.provider,
    suiteConfigs,
    samples: opts.samples,
    model: opts.model,
  });
}

interface BaselineComparisonOptions {
  drift: DriftReport;
  driftCeiling: number;
  mode: 'local' | 'ci';
  commit?: string;
  noiseFloor?: number;
  persistOnPass: boolean;
}

async function runBaselineComparison(
  opts: BaselineComparisonOptions,
): Promise<EvalResult['baselineDelta']> {
  const baseline = (() => {
    try {
      return loadBaseline();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[eval] Failed to load baseline: ${message}`);
      return null;
    }
  })();

  const current = snapshotFromDrift({
    drift: opts.drift,
    driftCeiling: opts.driftCeiling,
    commit: opts.commit,
    mode: opts.mode,
  });

  const delta = compareBaseline(current, baseline, {
    noiseFloor: opts.noiseFloor,
  });

  // Persist a new baseline on a passing run so the next run has a comparison
  // anchor — but NEVER ratchet the baseline UPWARD. If we re-persisted every
  // passing run, drift creeping up by less than the noise floor each run would
  // reset the anchor higher every time and climb unbounded without ever
  // tripping a regression (boiling-frog). So we only rewrite the baseline when
  // the run did not regress AND aggregate drift did not increase — the baseline
  // moves down on genuine improvement, or holds, but never drifts up on its own.
  const notWorseThanBaseline = !baseline || current.aggregateDrift <= baseline.aggregateDrift;
  if (opts.persistOnPass && !delta.hasRegression && notWorseThanBaseline) {
    writeBaseline(current);
  }

  return delta;
}

function printReport(
  drift: DriftReport,
  mode: 'local' | 'ci',
  baselineDelta: EvalResult['baselineDelta'],
  flakyTests: EvalResult['flakyTests'],
  suiteLoadErrors: Array<{
    suite: string;
    phase: 'deterministic' | 'semantic';
    error: string;
  }>,
): void {
  const report = formatReport(drift, mode);
  console.log(report.text);

  for (const annotation of report.annotations) {
    console.log(annotation);
  }

  if (flakyTests && flakyTests.length > 0) {
    console.warn(
      `[eval] ${flakyTests.length} flaky test(s) (inconsistent across samples):`,
    );
    for (const f of flakyTests) {
      console.warn(
        `  - ${f.suite}: passRate=${(f.passRate * 100).toFixed(0)}% over ${f.samples} samples`,
      );
    }
  }

  if (baselineDelta) {
    console.log('');
    console.log('── Baseline ──');
    console.log(formatBaselineDelta(baselineDelta));
  }

  if (suiteLoadErrors.length > 0) {
    console.error(`[eval] ${suiteLoadErrors.length} suite(s) failed to load:`);
    for (const err of suiteLoadErrors) {
      console.error(`  - ${err.suite} (${err.phase}): ${err.error}`);
    }
  }
}

// ─── CLI Entry Point ───────────────────────────────────────────────

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      mode: { type: 'string', short: 'm', default: 'local' },
      suite: { type: 'string', short: 's' },
      samples: { type: 'string' },
      baseline: { type: 'boolean', default: false },
      'deterministic-only': { type: 'boolean', default: false },
      'sut-model': { type: 'string' },
      'baseline-noise-floor': { type: 'string' },
      commit: { type: 'string' },
    },
    strict: false,
  });

  const mode = (values.mode === 'ci' ? 'ci' : 'local') as 'ci' | 'local';
  const suites = values.suite ? [values.suite as SuiteName] : undefined;

  const samples = values.samples
    ? parseInt(values.samples as string, 10)
    : undefined;
  const noiseFloor = values['baseline-noise-floor']
    ? parseFloat(values['baseline-noise-floor'] as string)
    : undefined;

  const result = await runEvals({
    mode,
    suites,
    samples,
    baseline: Boolean(values.baseline),
    deterministicOnly: Boolean(values['deterministic-only']),
    sutModel:
      typeof values['sut-model'] === 'string' ? values['sut-model'] : undefined,
    baselineNoiseFloor: noiseFloor,
    commit: typeof values.commit === 'string' ? values.commit : undefined,
  });

  // Exit code priority:
  //   1 — drift gate fail OR suite load error
  //   2 — baseline regression while gate passed
  //   0 — clean
  if (!result.drift.passed || result.suiteLoadErrors.length > 0) {
    process.exitCode = 1;
  } else if (result.baselineDelta?.hasRegression) {
    process.exitCode = 2;
  }
}

// Run if this is the entry point.
const isMainModule = (() => {
  try {
    return (
      process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
    );
  } catch {
    return false;
  }
})();

if (isMainModule) {
  main().catch((error) => {
    console.error('Eval runner failed:', error);
    process.exitCode = 1;
  });
}
