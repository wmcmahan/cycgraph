/**
 * Context-Engine Efficacy Runner
 *
 * Measures compression EFFICACY — information fidelity at a given
 * compression ratio — with an LLM judge. For every efficacy scenario and
 * every preset it reports the frontier:
 *
 *   preset x reduction% x compression-fidelity x QA-answerability
 *
 * Unlike the deterministic gate (which asserts calibrated ratchets on
 * gated presets only), this runner measures ALL presets — including ones
 * outside their intended domain — so preset limitations stay visible.
 *
 * Usage:
 *   npx tsx src/runner/efficacy.ts                 # local judge (Ollama)
 *   npx tsx src/runner/efficacy.ts --mode ci       # OpenAI judge
 *   npx tsx src/runner/efficacy.ts --samples 3
 *
 * @module runner/efficacy
 */

import { parseArgs } from 'node:util';
import { createOptimizedPipeline } from '@cycgraph/context-engine';
import type { PipelinePreset } from '@cycgraph/context-engine';
import { createOllamaProvider } from '../providers/ollama.js';
import { createOpenAIProvider } from '../providers/openai.js';
import type { EvalProvider } from '../providers/types.js';
import { evaluateMetricMultiSample, computeMedian } from './multi-sample.js';
import { COMPRESSION_FIDELITY, QA_ANSWERABILITY } from '../assertions/reference-free-judge.js';
import {
  EFFICACY_SCENARIOS,
  joinSegments,
  type EfficacyScenario,
} from '../suites/context-engine/efficacy-fixtures.js';

const PRESETS: PipelinePreset[] = ['fast', 'balanced', 'maximum'];

/** Pass thresholds for the frontier report. */
const FIDELITY_THRESHOLD = 0.8;
const ANSWERABILITY_THRESHOLD = 0.8;

export interface EfficacyCell {
  scenario: string;
  preset: PipelinePreset;
  gated: boolean;
  reductionPercent: number;
  fidelityMedian: number;
  fidelityStable: boolean;
  answerabilityMedian: number;
  /** Per-question medians, in qaProbes order. */
  answerability: number[];
  passed: boolean;
}

/**
 * Run the efficacy measurement for one scenario x preset cell.
 */
async function measureCell(
  scenario: EfficacyScenario,
  preset: PipelinePreset,
  provider: EvalProvider,
  samples: number,
): Promise<EfficacyCell> {
  const { pipeline } = createOptimizedPipeline({ preset });
  const original = joinSegments(scenario.segments);
  const result = pipeline.compress({
    segments: scenario.segments,
    budget: scenario.budget,
  });
  const compressed = joinSegments(result.segments);
  const callJudge = (prompt: string) => provider.callJudge(prompt);

  const fidelity = await evaluateMetricMultiSample(
    { input: original, actualOutput: compressed },
    COMPRESSION_FIDELITY,
    callJudge,
    { samples, threshold: FIDELITY_THRESHOLD },
  );

  const answerability: number[] = [];
  for (const probe of scenario.qaProbes) {
    const qa = await evaluateMetricMultiSample(
      { input: probe.question, actualOutput: compressed, expectedOutput: probe.answer },
      QA_ANSWERABILITY,
      callJudge,
      { samples, threshold: ANSWERABILITY_THRESHOLD },
    );
    answerability.push(qa.median);
  }

  const answerabilityMedian = computeMedian(answerability);
  const gated = scenario.gatePresets.includes(preset);

  return {
    scenario: scenario.name,
    preset,
    gated,
    reductionPercent: result.metrics.reductionPercent,
    fidelityMedian: fidelity.median,
    fidelityStable: fidelity.stable,
    answerabilityMedian,
    answerability,
    passed:
      fidelity.median >= FIDELITY_THRESHOLD &&
      answerabilityMedian >= ANSWERABILITY_THRESHOLD,
  };
}

/**
 * Run the full efficacy matrix (every scenario x every preset).
 */
export async function runEfficacyMatrix(
  provider: EvalProvider,
  samples: number,
): Promise<EfficacyCell[]> {
  const cells: EfficacyCell[] = [];
  for (const scenario of EFFICACY_SCENARIOS) {
    for (const preset of PRESETS) {
      cells.push(await measureCell(scenario, preset, provider, samples));
    }
  }
  return cells;
}

// ─── Report ────────────────────────────────────────────────────────

function formatReport(cells: EfficacyCell[]): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('Context-Engine Efficacy Frontier (fidelity at compression ratio)');
  lines.push(`thresholds: fidelity >= ${FIDELITY_THRESHOLD}, answerability >= ${ANSWERABILITY_THRESHOLD}; ungated cells are informational`);
  lines.push('');
  lines.push('scenario             preset    gated  reduction  fidelity  answerability  result');
  lines.push('─'.repeat(84));

  for (const c of cells) {
    const unstable = c.fidelityStable ? '' : ' (unstable)';
    lines.push(
      [
        c.scenario.padEnd(20),
        c.preset.padEnd(9),
        (c.gated ? 'yes' : 'no').padEnd(6),
        `${c.reductionPercent.toFixed(1)}%`.padEnd(10),
        c.fidelityMedian.toFixed(2).padEnd(9),
        c.answerabilityMedian.toFixed(2).padEnd(14),
        (c.passed ? 'PASS' : 'FAIL') + unstable,
      ].join(' '),
    );
  }

  lines.push('');
  return lines.join('\n');
}

// ─── CLI ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      mode: { type: 'string', short: 'm', default: 'local' },
      samples: { type: 'string' },
    },
    strict: false,
  });

  const mode = values.mode === 'ci' ? 'ci' : 'local';
  const samples = values.samples ? parseInt(values.samples as string, 10) : (mode === 'ci' ? 3 : 1);
  const provider = mode === 'ci' ? createOpenAIProvider() : createOllamaProvider();

  const judgeCalls = EFFICACY_SCENARIOS.reduce(
    (sum, s) => sum + (1 + s.qaProbes.length) * PRESETS.length * samples,
    0,
  );
  const cost = provider.estimateCost(judgeCalls);
  console.log(`judge: ${provider.name}, samples: ${samples}, judge calls: ${judgeCalls}, est. cost: $${cost.estimatedUsd.toFixed(2)}`);
  if (cost.warning) console.warn(cost.warning);

  const cells = await runEfficacyMatrix(provider, samples);
  console.log(formatReport(cells));

  // Gate on gated cells only — ungated cells are informational.
  const gatedFailures = cells.filter(c => c.gated && !c.passed);
  if (gatedFailures.length > 0) {
    console.error(`${gatedFailures.length} gated cell(s) below threshold`);
    process.exitCode = 1;
  }
}

// Only run when invoked directly (not when imported by tests).
const isDirectRun = process.argv[1]?.endsWith('efficacy.ts') || process.argv[1]?.endsWith('efficacy.js');
if (isDirectRun) {
  main().catch(err => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
