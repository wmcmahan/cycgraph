/**
 * Record Goldens
 *
 * Re-records golden trajectories by running each input through the System-
 * Under-Test and capturing observed output + tool calls. Each trajectory is
 * sampled N times to verify stability before its observed values are written
 * back. By default, runs in dry-run mode and emits a diff report; pass
 * `--commit` to overwrite the SQLite dataset.
 *
 * Usage:
 *   npx tsx scripts/record-goldens.ts --suite orchestrator
 *   npx tsx scripts/record-goldens.ts --suite orchestrator --model claude-sonnet-4-6 --samples 3
 *   npx tsx scripts/record-goldens.ts --suite orchestrator --commit
 *
 * Requires ANTHROPIC_API_KEY for any model under the `claude-*` family.
 * The script is intended for one-shot manual invocation; it is not wired
 * into CI.
 */

import { parseArgs } from 'node:util';
import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { loadGoldenTrajectories } from '../src/dataset/loader.js';
import { writeGoldenDataset } from '../src/dataset/writer.js';
import { runSutDispatch } from '../src/sut/dispatch.js';
import { planForTrajectory } from '../src/sut/recording-planner.js';
import type { RecordingPlan } from '../src/sut/recording-planner.js';
import type { GoldenTrajectory, SuiteName, ToolCall } from '../src/dataset/types.js';
import type { SutRunResult } from '../src/sut/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GOLDEN_DIR = resolve(__dirname, '../golden');
const RECORDING_SCHEMA_VERSION = '3.0.0';

// ─── CLI ────────────────────────────────────────────────────────────

interface CliArgs {
  suite: SuiteName;
  model: string;
  samples: number;
  commit: boolean;
  planOnly: boolean;
  outputPath: string;
}

function parseCliArgs(): CliArgs {
  const { values } = parseArgs({
    options: {
      suite: { type: 'string', short: 's', default: 'orchestrator' },
      model: { type: 'string', short: 'm', default: 'claude-sonnet-4-6' },
      samples: { type: 'string', default: '3' },
      commit: { type: 'boolean', default: false },
      'plan-only': { type: 'boolean', default: false },
      output: { type: 'string', short: 'o' },
    },
    strict: false,
  });

  const suite = values.suite as SuiteName;
  if (!['orchestrator', 'memory', 'context-engine', 'integration'].includes(suite)) {
    throw new Error(`Unknown suite "${suite}"`);
  }

  const samples = Number.parseInt(values.samples as string, 10);
  if (!Number.isFinite(samples) || samples < 1) {
    throw new Error(`Invalid --samples value "${values.samples}"`);
  }

  return {
    suite,
    model: values.model as string,
    samples,
    commit: Boolean(values.commit),
    planOnly: Boolean(values['plan-only']),
    outputPath: (values.output as string) ?? resolve(GOLDEN_DIR, `recording-diff-${suite}.json`),
  };
}

// ─── Tool Fixture Resolution ───────────────────────────────────────

// Trajectory → SUT plan dispatch lives in `../src/sut/recording-planner.ts`.
// SUT execution + tool-fixture resolution lives in `../src/sut/dispatch.ts`.

// ─── Stability + Sampling ──────────────────────────────────────────

interface SampleSet {
  trajectoryId: string;
  samples: SutRunResult[];
  toolCallsStable: boolean;
  errored: boolean;
}

/** Sample a trajectory N times and report whether tool-call shape is stable. */
async function sampleTrajectory(
  suite: SuiteName,
  plan: RecordingPlan,
  samples: number,
  model: string,
): Promise<SampleSet> {
  // Non-orchestrator suites are deterministic library calls — one sample is
  // sufficient. We still wrap in the same SampleSet shape so the downstream
  // diff + stability logic stays uniform.
  const effectiveSamples = suite === 'orchestrator' ? samples : 1;
  const results: SutRunResult[] = [];

  for (let i = 0; i < effectiveSamples; i++) {
    results.push(await runSample(suite, plan, model));
  }

  const errored = results.some(r => r.status !== 'completed');
  const toolCallsStable = errored ? false : toolShapesMatch(results);

  return {
    trajectoryId: plan.trajectory.id,
    samples: results,
    toolCallsStable,
    errored,
  };
}

/** Dispatch a single sample run to the correct SUT for the suite. */
async function runSample(
  suite: SuiteName,
  plan: RecordingPlan,
  model: string,
): Promise<SutRunResult> {
  return runSutDispatch({ suite, plan, model });
}

/** Two tool-call sequences match if they have the same tool names in order. */
function toolShapesMatch(results: SutRunResult[]): boolean {
  if (results.length < 2) return true;
  const signature = (r: SutRunResult) => r.toolCalls.map(c => c.toolName).join('|');
  const first = signature(results[0]);
  return results.every(r => signature(r) === first);
}

/**
 * Choose the canonical sample. We pick the one whose tool-call sequence
 * matches the majority and whose output is the shortest non-empty string —
 * a crude but stable tiebreaker.
 */
function chooseCanonical(set: SampleSet): SutRunResult {
  const completed = set.samples.filter(s => s.status === 'completed');
  if (completed.length === 0) return set.samples[0];

  const ranked = completed
    .slice()
    .sort((a, b) => {
      if (a.output.length === 0 && b.output.length > 0) return 1;
      if (b.output.length === 0 && a.output.length > 0) return -1;
      return a.output.length - b.output.length;
    });

  return ranked[0];
}

// ─── Trajectory Rebuilding ─────────────────────────────────────────

function gitHead(): string | undefined {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: __dirname }).toString().trim();
  } catch {
    return undefined;
  }
}

function toExpectedToolCalls(canonical: SutRunResult): ToolCall[] {
  return canonical.toolCalls.map(call => ({
    toolName: call.toolName,
    args: call.args,
  }));
}

function rebuildTrajectory(
  original: GoldenTrajectory,
  canonical: SutRunResult,
  model: string,
  commit: string | undefined,
): GoldenTrajectory {
  return {
    ...original,
    expectedOutput: canonical.output,
    expectedToolCalls: toExpectedToolCalls(canonical),
    source: 'recorded',
    recordedAt: new Date().toISOString(),
    recordedModel: model,
    recordedCommit: commit,
  };
}

// ─── Diff Report ───────────────────────────────────────────────────

interface TrajectoryDiff {
  id: string;
  description: string;
  status: 'recorded' | 'skipped' | 'unstable' | 'errored';
  reason?: string;
  before: {
    expectedOutput: GoldenTrajectory['expectedOutput'];
    expectedToolCalls?: ToolCall[];
  };
  after?: {
    expectedOutput: string;
    expectedToolCalls: ToolCall[];
  };
  samples?: Array<{ output: string; toolCalls: string[]; durationMs: number; status: string }>;
}

interface DiffReport {
  suite: string;
  model: string;
  samples: number;
  generatedAt: string;
  commit?: string;
  totals: { recorded: number; skipped: number; unstable: number; errored: number };
  trajectories: TrajectoryDiff[];
}

function summarizeSample(r: SutRunResult) {
  return {
    output: r.output,
    toolCalls: r.toolCalls.map(c => c.toolName),
    durationMs: r.durationMs,
    status: r.status,
  };
}

// ─── Main ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseCliArgs();

  console.log(`[record-goldens] suite=${args.suite} model=${args.model} samples=${args.samples} commit=${args.commit} plan-only=${args.planOnly}`);

  const trajectories = loadGoldenTrajectories(args.suite, GOLDEN_DIR);
  const commit = gitHead();
  const plans = trajectories.map(t => planForTrajectory(args.suite, t));

  // --plan-only short-circuit: print the classification table and exit
  // without invoking any SUT. Useful for verifying tag routing without an
  // ANTHROPIC_API_KEY or any real library calls.
  if (args.planOnly) {
    printPlanTable(plans);
    return;
  }

  // Only the orchestrator suite requires an LLM. Memory + context-engine
  // recording is a deterministic library snapshot — no API key needed.
  if (args.suite === 'orchestrator' && !process.env['ANTHROPIC_API_KEY']) {
    console.error('[record-goldens] ANTHROPIC_API_KEY is required for orchestrator recording.');
    console.error('[record-goldens] Set --plan-only to preview routing without an API key.');
    process.exitCode = 1;
    return;
  }

  const diff: DiffReport = {
    suite: args.suite,
    model: args.model,
    samples: args.samples,
    generatedAt: new Date().toISOString(),
    commit,
    totals: { recorded: 0, skipped: 0, unstable: 0, errored: 0 },
    trajectories: [],
  };

  const recorded: GoldenTrajectory[] = [];

  for (let i = 0; i < plans.length; i++) {
    const plan = plans[i];
    const idx = `${i + 1}/${plans.length}`;
    const label = `${plan.trajectory.id.slice(0, 8)} ${plan.trajectory.description.slice(0, 60)}`;

    if (!plan.supported) {
      console.log(`  [${idx}] SKIP  ${label} — ${plan.skipReason}`);
      diff.totals.skipped++;
      diff.trajectories.push({
        id: plan.trajectory.id,
        description: plan.trajectory.description,
        status: 'skipped',
        reason: plan.skipReason,
        before: {
          expectedOutput: plan.trajectory.expectedOutput,
          expectedToolCalls: plan.trajectory.expectedToolCalls,
        },
      });
      recorded.push(plan.trajectory); // keep the existing trajectory unchanged
      continue;
    }

    console.log(`  [${idx}] REC   ${label}`);
    const set = await sampleTrajectory(args.suite, plan, args.samples, args.model);

    if (set.errored) {
      console.log(`         ERROR  ${set.samples.find(s => s.error)?.error ?? 'unknown error'}`);
      diff.totals.errored++;
      diff.trajectories.push({
        id: plan.trajectory.id,
        description: plan.trajectory.description,
        status: 'errored',
        reason: set.samples.find(s => s.error)?.error,
        before: {
          expectedOutput: plan.trajectory.expectedOutput,
          expectedToolCalls: plan.trajectory.expectedToolCalls,
        },
        samples: set.samples.map(summarizeSample),
      });
      recorded.push(plan.trajectory);
      continue;
    }

    if (!set.toolCallsStable) {
      console.log('         UNSTABLE  tool-call shape diverged across samples');
      diff.totals.unstable++;
      diff.trajectories.push({
        id: plan.trajectory.id,
        description: plan.trajectory.description,
        status: 'unstable',
        reason: 'Tool-call sequence varied across samples',
        before: {
          expectedOutput: plan.trajectory.expectedOutput,
          expectedToolCalls: plan.trajectory.expectedToolCalls,
        },
        samples: set.samples.map(summarizeSample),
      });
      recorded.push(plan.trajectory);
      continue;
    }

    const canonical = chooseCanonical(set);
    const rebuilt = rebuildTrajectory(plan.trajectory, canonical, args.model, commit);
    recorded.push(rebuilt);

    diff.totals.recorded++;
    diff.trajectories.push({
      id: plan.trajectory.id,
      description: plan.trajectory.description,
      status: 'recorded',
      before: {
        expectedOutput: plan.trajectory.expectedOutput,
        expectedToolCalls: plan.trajectory.expectedToolCalls,
      },
      after: {
        expectedOutput: rebuilt.expectedOutput as string,
        expectedToolCalls: rebuilt.expectedToolCalls ?? [],
      },
      samples: set.samples.map(summarizeSample),
    });
  }

  writeFileSync(args.outputPath, JSON.stringify(diff, null, 2) + '\n');
  console.log(`\n[record-goldens] Diff written to: ${args.outputPath}`);
  console.log(`[record-goldens] Totals: recorded=${diff.totals.recorded} skipped=${diff.totals.skipped} unstable=${diff.totals.unstable} errored=${diff.totals.errored}`);

  if (args.commit) {
    if (diff.totals.errored > 0 || diff.totals.unstable > 0) {
      console.error('[record-goldens] Refusing to --commit with errored/unstable trajectories. Re-run with adjustments first.');
      process.exitCode = 1;
      return;
    }
    writeGoldenDataset(args.suite, recorded, RECORDING_SCHEMA_VERSION, GOLDEN_DIR);
    console.log(`[record-goldens] Wrote ${recorded.length} trajectories to ${args.suite} dataset (schema v${RECORDING_SCHEMA_VERSION}).`);
  } else {
    console.log('[record-goldens] Dry run — pass --commit to overwrite the SQLite dataset.');
  }
}

/** Print a compact routing table for `--plan-only`. */
function printPlanTable(plans: RecordingPlan[]): void {
  let supported = 0;
  let skipped = 0;
  for (let i = 0; i < plans.length; i++) {
    const p = plans[i];
    const idx = `${i + 1}/${plans.length}`;
    const id = p.trajectory.id.slice(0, 8);
    const desc = p.trajectory.description.slice(0, 60);

    if (!p.supported) {
      console.log(`  [${idx}] SKIP   ${id} ${desc} — ${p.skipReason}`);
      skipped++;
      continue;
    }

    const route = p.graphKind
      ? `graph=${p.graphKind} tool=${p.toolKind ?? 'none'}`
      : 'handler-dispatched';
    console.log(`  [${idx}] PLAN   ${id} ${desc} — ${route}`);
    supported++;
  }
  console.log(`\n[record-goldens] plan totals: supported=${supported} skipped=${skipped}`);
}

main().catch((err) => {
  console.error('[record-goldens] Failed:', err);
  process.exitCode = 1;
});
