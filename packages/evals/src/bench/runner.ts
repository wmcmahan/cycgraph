/**
 * Compression Benchmark Runner
 *
 * Runs every registered compression engine over the same questions at the
 * same token budgets, asks the same reader model to answer from each
 * compressed context, and scores with SQuAD-standard EM/F1. Reports the
 * frontier (accuracy vs compression ratio) with paired deltas against the
 * no-compression ceiling and 95% confidence intervals.
 *
 * Anti-fudging invariants:
 * - Config is frozen in bench.config.json; its hash is embedded in results.
 * - The evaluation subset is seeded and content-hashed.
 * - Unavailable adapters are reported as skipped, never silently omitted.
 * - Per-question raw results ship in the JSON output for re-analysis.
 *
 * Usage:
 *   npm run bench:smoke                # bundled items (sanity)
 *   npm run bench                      # full run — Claude reader (pinned Haiku 4.5)
 *   npx tsx src/bench/runner.ts --reader ollama --model qwen2.5:7b   # free local
 *   npx tsx src/bench/runner.ts --reader openai --model gpt-4o-mini  # third-party
 *
 * @module bench/runner
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { config as loadDotenv } from 'dotenv';
import { createAnthropicProvider } from '../providers/anthropic.js';
import { createOllamaProvider } from '../providers/ollama.js';
import { createOpenAIProvider } from '../providers/openai.js';
import type { EvalProvider } from '../providers/types.js';
import type {
  BenchConfig,
  BenchQuestion,
  BenchReport,
  CellResult,
  CompressorAdapter,
  QuestionResult,
} from './types.js';
import { bestExactMatch, bestF1, mean, ci95 } from './metrics.js';
import { countTokens } from './token-utils.js';
import { createCycgraphAdapter, createCycgraphQueryAwareAdapter, createCycgraphRelevanceAdapter } from './adapters/cycgraph.js';
import {
  noneAdapter,
  truncationTailAdapter,
  truncationHeadAdapter,
  randomDropAdapter,
} from './adapters/naive.js';
import { llmlinguaAdapter, stopLlmlinguaBridge } from './adapters/llmlingua.js';
import { fetchHotpotQA, selectSubset, SMOKE_QUESTIONS, BENCH_DATA_DIR } from './dataset/hotpotqa.js';
import { fetchMusique, selectMusiqueSubset } from './dataset/musique.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = resolve(__dirname, '../../bench.config.json');
const RESULTS_DIR = resolve(__dirname, '../../bench-results');

// Load API keys from the repo root .env (repo convention; never overrides
// variables already set in the environment).
loadDotenv({ path: resolve(__dirname, '../../../../.env'), quiet: true });

/** Registry of every adapter the harness knows. Add competitors here. */
export const ADAPTER_REGISTRY: CompressorAdapter[] = [
  noneAdapter,
  truncationTailAdapter,
  truncationHeadAdapter,
  randomDropAdapter,
  createCycgraphAdapter('fast'),
  createCycgraphAdapter('balanced'),
  createCycgraphAdapter('maximum'),
  createCycgraphQueryAwareAdapter('fast'),
  createCycgraphRelevanceAdapter(),
  llmlinguaAdapter,
];

// ─── Reader ────────────────────────────────────────────────────────

function buildReaderPrompt(context: string, question: string): string {
  return [
    'Answer the question using ONLY the context below. Respond with the shortest exact answer span (a name, number, date, or short phrase) and nothing else.',
    '',
    'Context:',
    context,
    '',
    `Question: ${question}`,
    'Answer:',
  ].join('\n');
}

/** Extract the answer span from a reader response (first non-empty line). */
export function extractAnswer(response: string): string {
  const line = response.split('\n').map(l => l.trim()).find(l => l.length > 0) ?? '';
  return line.replace(/^answer:\s*/i, '').trim();
}

// ─── Core loop ─────────────────────────────────────────────────────

export interface RunBenchOptions {
  config: BenchConfig;
  questions: BenchQuestion[];
  subsetHash: string;
  reader: EvalProvider;
  readerModel: string;
  log?: (message: string) => void;
  /**
   * Checkpoint hook: called after every completed cell with the cell and a
   * snapshot of all cells so far. Use to persist partial results — a
   * killed run keeps everything completed up to that point.
   */
  onCellComplete?: (cell: CellResult, cellsSoFar: CellResult[]) => void;
  /**
   * Cells from a previous (partial) run of the SAME config + subset —
   * matching (adapter, ratio) cells are reused instead of re-run. Callers
   * must validate configHash/subsetHash before passing these.
   */
  completedCells?: CellResult[];
}

export async function runBench(opts: RunBenchOptions): Promise<BenchReport> {
  const { config, questions, reader } = opts;
  const log = opts.log ?? (() => {});
  const onCellComplete = opts.onCellComplete ?? (() => {});
  const startedAt = new Date().toISOString();

  const missing = config.adapters.filter(name => !ADAPTER_REGISTRY.some(a => a.name === name));
  if (missing.length > 0) {
    throw new Error(`Unknown adapters in config: ${missing.join(', ')}`);
  }
  // Preserve config order — the reference adapter (if any) must run first
  // among non-ceiling adapters, so reorder it to the front.
  const requested = config.adapters
    .map(name => ADAPTER_REGISTRY.find(a => a.name === name)!)
    .sort((a, b) =>
      (a.name === config.budgetReference ? 0 : 1) - (b.name === config.budgetReference ? 0 : 1));

  if (config.budgetReference !== undefined && !config.adapters.includes(config.budgetReference)) {
    throw new Error(`budgetReference "${config.budgetReference}" is not in config.adapters`);
  }

  const adapters: CompressorAdapter[] = [];
  const skippedAdapters: string[] = [];
  for (const adapter of requested) {
    if (await adapter.available()) adapters.push(adapter);
    else skippedAdapters.push(adapter.name);
  }
  if (skippedAdapters.length > 0) {
    log(`skipped (unavailable): ${skippedAdapters.join(', ')}`);
  }
  if (config.budgetReference !== undefined && skippedAdapters.includes(config.budgetReference)) {
    throw new Error(`budgetReference "${config.budgetReference}" is unavailable in this environment`);
  }

  const done = new Map<string, CellResult>(
    (opts.completedCells ?? []).map(c => [`${c.adapter}|${c.ratio}`, c]),
  );
  const reused = (adapter: string, ratio: number): CellResult | undefined =>
    done.get(`${adapter}|${ratio}`);

  const askReader = async (context: string, question: string): Promise<string> => {
    const response = await reader.callJudge(buildReaderPrompt(context, question));
    return extractAnswer(response);
  };

  // Gold surface forms: answer + aliases (max-over-golds is the official
  // protocol for alias-bearing datasets; single-gold datasets unaffected).
  const goldsOf = (q: BenchQuestion): string[] => [q.answer, ...(q.answerAliases ?? [])];

  const runCell = async (
    adapter: CompressorAdapter,
    ratio: number,
    budgetFor: (q: BenchQuestion) => number,
    ceiling: Map<string, QuestionResult>,
  ): Promise<CellResult> => {
    const results: QuestionResult[] = [];
    for (const q of questions) {
      const output = await adapter.compress(q, budgetFor(q));
      const prediction = await askReader(output.compressed, q.question);
      results.push({
        questionId: q.id,
        exactMatch: bestExactMatch(prediction, goldsOf(q)),
        f1: bestF1(prediction, goldsOf(q)),
        outputTokens: output.outputTokens,
        compressionMs: output.durationMs,
      });
    }
    return buildCell(adapter.name, ratio, results, ceiling, questions);
  };

  const cells: CellResult[] = [];
  const emit = (cell: CellResult): void => {
    cells.push(cell);
    onCellComplete(cell, [...cells]);
  };

  // Ceiling first: paired deltas need per-question uncompressed scores.
  let ceilingCell = reused('none', 1.0);
  if (ceilingCell) {
    log(`ceiling: none (resumed)`);
  } else {
    log(`ceiling: none (${questions.length} questions)`);
    const ceilingResults: QuestionResult[] = [];
    for (const q of questions) {
      const output = await noneAdapter.compress(q, Number.MAX_SAFE_INTEGER);
      const prediction = await askReader(output.compressed, q.question);
      ceilingResults.push({
        questionId: q.id,
        exactMatch: bestExactMatch(prediction, goldsOf(q)),
        f1: bestF1(prediction, goldsOf(q)),
        outputTokens: output.outputTokens,
        compressionMs: output.durationMs,
      });
    }
    const selfMap = new Map(ceilingResults.map(q => [q.questionId, q]));
    ceilingCell = buildCell('none', 1.0, ceilingResults, selfMap, questions);
  }
  const ceiling = new Map(ceilingCell.questions.map(q => [q.questionId, q]));
  emit(ceilingCell);

  // Budget derivation. Matched mode: the reference adapter's ACHIEVED
  // per-question tokens become everyone else's budget for that ratio.
  const targetBudget = (q: BenchQuestion, ratio: number): number =>
    Math.max(1, Math.ceil(ceiling.get(q.id)!.outputTokens * ratio));

  const referenceTokens = new Map<number, Map<string, number>>();
  if (config.budgetReference !== undefined) {
    const reference = adapters.find(a => a.name === config.budgetReference)!;
    for (const ratio of config.ratios) {
      let refCell = reused(reference.name, ratio);
      if (refCell) {
        log(`${reference.name} @ ratio ${ratio} (reference, resumed)`);
      } else {
        log(`${reference.name} @ ratio ${ratio} (reference)`);
        refCell = await runCell(reference, ratio, q => targetBudget(q, ratio), ceiling);
      }
      emit(refCell);
      referenceTokens.set(
        ratio,
        new Map(refCell.questions.map(q => [q.questionId, Math.max(1, q.outputTokens)])),
      );
    }
  }

  const budgetFor = (q: BenchQuestion, ratio: number): number =>
    referenceTokens.get(ratio)?.get(q.id) ?? targetBudget(q, ratio);

  for (const adapter of adapters) {
    if (adapter.name === 'none' || adapter.name === config.budgetReference) continue;
    for (const ratio of config.ratios) {
      const prior = reused(adapter.name, ratio);
      if (prior) {
        log(`${adapter.name} @ ratio ${ratio} (resumed)`);
        emit(prior);
        continue;
      }
      log(`${adapter.name} @ ratio ${ratio}`);
      emit(await runCell(adapter, ratio, q => budgetFor(q, ratio), ceiling));
    }
  }

  return {
    config,
    configHash: hashConfig(config),
    subsetHash: opts.subsetHash,
    readerModel: opts.readerModel,
    startedAt,
    cells,
    skippedAdapters,
    adapterVersions: Object.fromEntries(adapters.map(a => [a.name, a.version])),
  };
}

function buildCell(
  adapter: string,
  ratio: number,
  results: QuestionResult[],
  ceiling: Map<string, QuestionResult>,
  questions: BenchQuestion[],
): CellResult {
  const pairedDeltas = results.map(r => r.f1 - (ceiling.get(r.questionId)?.f1 ?? 0));
  const originalTokens = questions.map(q => ceiling.get(q.id)!.outputTokens);
  const achieved = results.map((r, i) => r.outputTokens / Math.max(1, originalTokens[i]));

  return {
    adapter,
    ratio,
    achievedRatio: mean(achieved),
    meanExactMatch: mean(results.map(r => r.exactMatch)),
    meanF1: mean(results.map(r => r.f1)),
    f1DeltaVsNone: mean(pairedDeltas),
    f1DeltaCi95: ci95(pairedDeltas),
    meanCompressionMs: mean(results.map(r => r.compressionMs)),
    questions: results,
  };
}

export function hashConfig(config: BenchConfig): string {
  return createHash('sha256').update(JSON.stringify(config)).digest('hex');
}

// ─── Report ────────────────────────────────────────────────────────

export function formatMarkdownReport(report: BenchReport): string {
  const lines: string[] = [];
  lines.push(`## Compression Benchmark — ${report.config.dataset}`);
  lines.push('');
  lines.push(`- questions: ${report.cells[0]?.questions.length ?? 0} (subset sha256 \`${report.subsetHash.slice(0, 12)}…\`, seed ${report.config.seed})`);
  lines.push(`- reader: ${report.readerModel}`);
  lines.push(`- config: \`${report.configHash.slice(0, 12)}…\` | started: ${report.startedAt}`);
  if (report.config.budgetReference) {
    lines.push(`- budgets: matched to **${report.config.budgetReference}** achieved per-question tokens (all cells in a ratio group sit at identical achieved compression)`);
  } else {
    lines.push('- budgets: target-ratio caps (achieved column shows overshoot; cells are NOT budget-matched)');
  }
  if (report.skippedAdapters.length > 0) {
    lines.push(`- **skipped (unavailable): ${report.skippedAdapters.join(', ')}**`);
  }
  lines.push('');
  lines.push('| adapter | target ratio | achieved | EM | F1 | ΔF1 vs none (±95% CI) | compress ms |');
  lines.push('|---|---|---|---|---|---|---|');

  for (const cell of report.cells) {
    const delta = cell.adapter === 'none'
      ? '—'
      : `${cell.f1DeltaVsNone >= 0 ? '+' : ''}${cell.f1DeltaVsNone.toFixed(3)} (±${cell.f1DeltaCi95.toFixed(3)})`;
    lines.push(
      `| ${cell.adapter} | ${cell.ratio.toFixed(2)} | ${cell.achievedRatio.toFixed(2)} | ${cell.meanExactMatch.toFixed(3)} | ${cell.meanF1.toFixed(3)} | ${delta} | ${cell.meanCompressionMs.toFixed(1)} |`,
    );
  }

  lines.push('');
  return lines.join('\n');
}

// ─── CLI ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      smoke: { type: 'boolean', default: false },
      // Default reader: Claude (pinned Haiku 4.5) — off-device, reproducible.
      // 'ollama' for free local iteration, 'openai' for a third-party reader.
      reader: { type: 'string', default: 'claude' },
      model: { type: 'string' },
      questions: { type: 'string' },
      resume: { type: 'string' },
      'budget-reference': { type: 'string' },
      // Frozen config file (default: bench.config.json = HotpotQA). Each
      // dataset keeps its own committed config so hashes stay meaningful,
      // e.g. --config bench.musique.config.json.
      config: { type: 'string' },
    },
    strict: false,
  });

  const configPath = values.config
    ? resolve(process.cwd(), values.config as string)
    : CONFIG_PATH;
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as BenchConfig;
  if (values.questions) config.subsetSize = parseInt(values.questions as string, 10);
  if (values['budget-reference'] !== undefined) {
    // 'none' disables matched budgets for a target-ratio run.
    config.budgetReference = values['budget-reference'] === 'none'
      ? undefined
      : (values['budget-reference'] as string);
  }

  const modelOpt = values.model ? { model: values.model as string } : {};
  const reader: EvalProvider =
    values.reader === 'openai' ? createOpenAIProvider(modelOpt)
    : values.reader === 'ollama' ? createOllamaProvider(modelOpt)
    : createAnthropicProvider(modelOpt);

  let questions: BenchQuestion[];
  let subsetHash: string;
  if (values.smoke) {
    questions = SMOKE_QUESTIONS;
    subsetHash = 'smoke (bundled items — NOT for reporting)';
    console.log('SMOKE MODE: bundled questions, results are for pipeline sanity only.');
  } else if (config.dataset.startsWith('musique')) {
    const rawPath = await fetchMusique(config.datasetUrl, config.datasetSha256);
    const subset = selectMusiqueSubset(rawPath, config.subsetSize, config.seed);
    questions = subset.questions;
    subsetHash = subset.subsetHash;
    console.log(`subset: ${questions.length} questions, sha256 ${subsetHash.slice(0, 16)}…`);
  } else {
    const rawPath = await fetchHotpotQA(config.datasetUrl);
    const subset = selectSubset(rawPath, config.subsetSize, config.seed);
    questions = subset.questions;
    subsetHash = subset.subsetHash;
    console.log(`subset: ${questions.length} questions, sha256 ${subsetHash.slice(0, 16)}…`);
  }

  // Resume from a partial artifact — only if it was the same experiment.
  let completedCells: BenchReport['cells'] | undefined;
  if (values.resume) {
    const partial = JSON.parse(readFileSync(values.resume as string, 'utf8')) as BenchReport;
    if (partial.configHash !== hashConfig(config) || partial.subsetHash !== subsetHash) {
      throw new Error(
        '--resume artifact does not match the current config/subset — refusing to mix experiments.',
      );
    }
    completedCells = partial.cells;
    console.log(`resuming: ${completedCells.length} completed cell(s) reused from ${values.resume}`);
  }

  // Checkpoint after every cell so a killed run keeps its completed cells.
  mkdirSync(RESULTS_DIR, { recursive: true });
  const startStamp = new Date().toISOString().replace(/[:.]/g, '-');
  const partialPath = resolve(RESULTS_DIR, `partial-${startStamp}.json`);
  const checkpoint = (cellsSoFar: BenchReport['cells']): void => {
    const snapshot: BenchReport = {
      config,
      configHash: hashConfig(config),
      subsetHash,
      readerModel: reader.name,
      startedAt: startStamp,
      cells: cellsSoFar,
      skippedAdapters: [],
    };
    writeFileSync(partialPath, JSON.stringify(snapshot, null, 1));
  };

  const report = await runBench({
    config,
    questions,
    subsetHash,
    reader,
    readerModel: reader.name,
    log: m => console.log(`  ${m}`),
    completedCells,
    onCellComplete: (_cell, cellsSoFar) => checkpoint(cellsSoFar),
  });

  console.log(formatMarkdownReport(report));

  const stamp = report.startedAt.replace(/[:.]/g, '-');
  const outPath = resolve(RESULTS_DIR, `bench-${stamp}-${report.configHash.slice(0, 8)}.json`);
  writeFileSync(outPath, JSON.stringify(report, null, 1));
  rmSync(partialPath, { force: true });
  console.log(`raw results: ${outPath}`);
  console.log(`data cache: ${BENCH_DATA_DIR}`);
}

const isDirectRun = process.argv[1]?.endsWith('runner.ts') || process.argv[1]?.endsWith('runner.js');
if (isDirectRun && process.argv[1]?.includes('bench')) {
  main()
    .catch(err => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    })
    .finally(() => {
      // The persistent LLMLingua bridge child would otherwise keep the
      // process alive after the benchmark completes.
      stopLlmlinguaBridge();
    });
}
