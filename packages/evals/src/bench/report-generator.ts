/**
 * BENCHMARKS.md Generator
 *
 * Turns raw benchmark artifacts (the JSON files the runner writes to
 * bench-results/) into a publishable markdown document. Designed to be
 * the evaluation section of a technical writeup, so the rules are strict:
 *
 * - **Everything is computed from the artifacts.** No hand-entered
 *   numbers, no prose judgments. "Significant" means exactly |paired
 *   mean| > 95% CI half-width; anything else is "indistinguishable".
 * - **Negative results are emitted with the rest** — cells where the
 *   headline engine loses or ties are listed in their own section, not
 *   dropped.
 * - **Provenance is complete**: config hash, subset hash, dataset
 *   URL + content hash, reader model, engine versions, skipped adapters,
 *   and the reproduction command for every dataset.
 *
 * Usage:
 *   npm run bench:report -- bench-results/<a>.json bench-results/<b>.json
 *   npm run bench:report -- <artifacts...> --out ../context-engine/BENCHMARKS.md
 *
 * @module bench/report-generator
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { BenchReport, CellResult, QuestionResult } from './types.js';
import { mean, ci95 } from './metrics.js';

/** Ceiling F1 at or above which a question counts as "solvable". */
export const SOLVABLE_F1 = 0.5;

/** The engine whose rows are compared head-to-head against competitors. */
const HEADLINE = 'cycgraph-fast-relevance';
/** Competitors for the paired head-to-head section (when present). */
const COMPARISONS = ['llmlingua-2', 'cycgraph-fast', 'truncation-tail'];

interface Cells {
  byKey: Map<string, CellResult>;
  questions: (adapter: string, ratio: number) => Map<string, QuestionResult>;
}

function index(report: BenchReport): Cells {
  const byKey = new Map(report.cells.map(c => [`${c.adapter}|${c.ratio}`, c]));
  return {
    byKey,
    questions: (adapter, ratio) => {
      const cell = byKey.get(`${adapter}|${ratio}`);
      return new Map((cell?.questions ?? []).map(q => [q.questionId, q]));
    },
  };
}

function ratios(report: BenchReport): number[] {
  return report.config.ratios;
}

function adapterOrder(report: BenchReport): string[] {
  // Preserve first-seen cell order, ceiling first, headline second.
  const seen: string[] = [];
  for (const c of report.cells) {
    if (!seen.includes(c.adapter)) seen.push(c.adapter);
  }
  return seen.sort((a, b) => {
    const rank = (x: string): number => (x === 'none' ? 0 : x === HEADLINE ? 1 : 2);
    return rank(a) - rank(b) || seen.indexOf(a) - seen.indexOf(b);
  });
}

function pairedDelta(
  cells: Cells,
  a: string,
  b: string,
  ratio: number,
): { mean: number; ci: number; n: number } | undefined {
  const qa = cells.questions(a, ratio);
  const qb = cells.questions(b, ratio);
  if (qa.size === 0 || qb.size === 0) return undefined;
  const deltas = [...qa.entries()]
    .filter(([id]) => qb.has(id))
    .map(([id, q]) => q.f1 - qb.get(id)!.f1);
  return { mean: mean(deltas), ci: ci95(deltas), n: deltas.length };
}

function solvableIds(cells: Cells): string[] {
  return [...cells.questions('none', 1.0).entries()]
    .filter(([, q]) => q.f1 >= SOLVABLE_F1)
    .map(([id]) => id);
}

function retained(cells: Cells, adapter: string, ratio: number, ids: string[]): number {
  const qs = cells.questions(adapter, ratio);
  return ids.filter(id => (qs.get(id)?.f1 ?? 0) >= SOLVABLE_F1).length;
}

function fmtDelta(d: { mean: number; ci: number }): string {
  return `${d.mean >= 0 ? '+' : ''}${d.mean.toFixed(3)} (±${d.ci.toFixed(3)})`;
}

function verdict(d: { mean: number; ci: number }): string {
  if (Math.abs(d.mean) <= d.ci) return 'indistinguishable';
  return d.mean > 0 ? '**significant win**' : '**significant loss**';
}

/** Hop prefix from a MuSiQue question id (`2hop__...` → `2hop`), or undefined. */
function hopOf(id: string): string | undefined {
  const m = id.match(/^(\d)hop/);
  return m ? `${m[1]}hop` : undefined;
}

// ─── Sections ──────────────────────────────────────────────────────

function provenanceSection(report: BenchReport, artifactName: string): string[] {
  const lines: string[] = [];
  const n = report.cells[0]?.questions.length ?? 0;
  lines.push(`- questions: **${n}** (seeded subset, seed ${report.config.seed}; subset sha256 \`${report.subsetHash.slice(0, 16)}…\`)`);
  lines.push(`- dataset source: ${report.config.datasetUrl}`);
  if (report.config.datasetSha256) {
    lines.push(`- raw dataset sha256: \`${report.config.datasetSha256}\` (verified at load)`);
  }
  lines.push(`- reader model: \`${report.readerModel}\``);
  lines.push(`- config sha256: \`${report.configHash.slice(0, 16)}…\` | run started: ${report.startedAt} | artifact: \`${artifactName}\``);
  if (report.config.budgetReference) {
    lines.push(`- budgets: **matched** — every adapter receives \`${report.config.budgetReference}\`'s achieved per-question token counts, so all cells in a ratio group sit at identical achieved compression`);
  } else {
    lines.push('- budgets: target-ratio caps (cells are NOT budget-matched; compare at achieved ratio)');
  }
  if (report.skippedAdapters.length > 0) {
    lines.push(`- **skipped (unavailable in the run environment): ${report.skippedAdapters.join(', ')}**`);
  }
  if (report.adapterVersions) {
    const versions = Object.entries(report.adapterVersions)
      .map(([name, v]) => `${name}@${v}`)
      .join(', ');
    lines.push(`- engine versions: ${versions}`);
  }
  return lines;
}

function frontierSection(report: BenchReport, cells: Cells): string[] {
  const lines: string[] = [];
  lines.push('| adapter | target | achieved | EM | F1 | ΔF1 vs no compression (±95% CI) | compress ms |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const adapter of adapterOrder(report)) {
    const cellRatios = adapter === 'none' ? [1.0] : ratios(report);
    for (const ratio of cellRatios) {
      const cell = cells.byKey.get(`${adapter}|${ratio}`);
      if (!cell) continue;
      const delta = adapter === 'none'
        ? '—'
        : `${cell.f1DeltaVsNone >= 0 ? '+' : ''}${cell.f1DeltaVsNone.toFixed(3)} (±${cell.f1DeltaCi95.toFixed(3)})`;
      lines.push(
        `| ${adapter} | ${ratio.toFixed(2)} | ${cell.achievedRatio.toFixed(2)} | ` +
        `${cell.meanExactMatch.toFixed(3)} | ${cell.meanF1.toFixed(3)} | ${delta} | ${cell.meanCompressionMs.toFixed(1)} |`,
      );
    }
  }
  return lines;
}

function headToHeadSection(report: BenchReport, cells: Cells): string[] {
  const lines: string[] = [];
  const present = COMPARISONS.filter(c => cells.byKey.has(`${c}|${ratios(report)[0]}`));
  if (!cells.byKey.has(`${HEADLINE}|${ratios(report)[0]}`) || present.length === 0) {
    return ['_Headline adapter or comparison adapters absent from this run._'];
  }
  lines.push(`Paired per-question F1 deltas, \`${HEADLINE}\` minus competitor. Positive favors \`${HEADLINE}\`; a result is significant iff |mean| exceeds the 95% CI half-width.`);
  lines.push('');
  lines.push('| vs | ' + ratios(report).map(r => `@${r}`).join(' | ') + ' |');
  lines.push('|---|' + ratios(report).map(() => '---').join('|') + '|');
  for (const competitor of present) {
    const row = ratios(report).map(r => {
      const d = pairedDelta(cells, HEADLINE, competitor, r);
      return d ? `${fmtDelta(d)} ${verdict(d)}` : '—';
    });
    lines.push(`| ${competitor} | ${row.join(' | ')} |`);
  }
  return lines;
}

function retentionSection(report: BenchReport, cells: Cells): string[] {
  const ids = solvableIds(cells);
  const total = cells.questions('none', 1.0).size;
  const lines: string[] = [];
  lines.push(`Of ${total} questions, **${ids.length}** are solvable uncompressed (ceiling F1 ≥ ${SOLVABLE_F1}). Cells show how many stay solvable after compression.`);
  lines.push('');
  lines.push('| adapter | ' + ratios(report).map(r => `@${r}`).join(' | ') + ' |');
  lines.push('|---|' + ratios(report).map(() => '---').join('|') + '|');
  for (const adapter of adapterOrder(report)) {
    if (adapter === 'none') continue;
    const row = ratios(report).map(r =>
      cells.byKey.has(`${adapter}|${r}`) ? `${retained(cells, adapter, r, ids)}/${ids.length}` : '—');
    lines.push(`| ${adapter} | ${row.join(' | ')} |`);
  }
  return lines;
}

function hopSection(report: BenchReport, cells: Cells): string[] {
  const ids = solvableIds(cells);
  const hops = [...new Set(ids.map(hopOf).filter((h): h is string => h !== undefined))].sort();
  if (hops.length === 0) return [];

  const adapters = adapterOrder(report).filter(a => a !== 'none');
  const lines: string[] = [];
  lines.push('## Retention by hop count');
  lines.push('');
  lines.push('MuSiQue question ids encode how many documents the answer chains through. Retention of solvable questions per hop stratum (small strata — read with the CIs above, not alone):');
  lines.push('');
  for (const ratio of ratios(report)) {
    lines.push(`**@${ratio}**`);
    lines.push('');
    lines.push('| hop | n | ' + adapters.join(' | ') + ' |');
    lines.push('|---|---|' + adapters.map(() => '---').join('|') + '|');
    for (const hop of hops) {
      const hopIds = ids.filter(id => hopOf(id) === hop);
      const row = adapters.map(a =>
        cells.byKey.has(`${a}|${ratio}`) ? `${retained(cells, a, ratio, hopIds)}` : '—');
      lines.push(`| ${hop} | ${hopIds.length} | ${row.join(' | ')} |`);
    }
    lines.push('');
  }
  return lines;
}

function negativesSection(reports: Array<{ report: BenchReport; cells: Cells }>): string[] {
  const lines: string[] = [];
  for (const { report, cells } of reports) {
    for (const ratio of ratios(report)) {
      // Headline losses/ties vs competitors
      for (const competitor of COMPARISONS) {
        const d = pairedDelta(cells, HEADLINE, competitor, ratio);
        if (d && d.mean <= d.ci) {
          const kind = Math.abs(d.mean) <= d.ci ? 'indistinguishable from' : 'loses to';
          lines.push(`- ${report.config.dataset} @${ratio}: \`${HEADLINE}\` ${kind} \`${competitor}\` (${fmtDelta(d)}).`);
        }
      }
      // Cost vs the uncompressed ceiling
      const cell = cells.byKey.get(`${HEADLINE}|${ratio}`);
      if (cell && cell.f1DeltaVsNone < 0 && Math.abs(cell.f1DeltaVsNone) > cell.f1DeltaCi95) {
        lines.push(`- ${report.config.dataset} @${ratio}: compression is not free — \`${HEADLINE}\` costs ${cell.f1DeltaVsNone.toFixed(3)} (±${cell.f1DeltaCi95.toFixed(3)}) F1 vs no compression.`);
      }
    }
    if (report.skippedAdapters.length > 0) {
      lines.push(`- ${report.config.dataset}: adapters skipped as unavailable: ${report.skippedAdapters.join(', ')}.`);
    }
  }
  return lines.length > 0 ? lines : ['- None detected in these artifacts.'];
}

// ─── Document ──────────────────────────────────────────────────────

/**
 * Generate the full BENCHMARKS.md document from one artifact per dataset.
 * Pure function of the artifacts — regenerating from the same inputs
 * yields byte-identical output.
 */
export function generateBenchmarksMarkdown(
  inputs: Array<{ report: BenchReport; artifactName: string }>,
): string {
  const indexed = inputs.map(({ report, artifactName }) => ({
    report,
    artifactName,
    cells: index(report),
  }));

  const lines: string[] = [];
  lines.push('# Compression Benchmarks');
  lines.push('');
  lines.push('> Generated by the `@cycgraph/evals` benchmark harness from the raw artifacts named below — do not edit by hand. Every number is computed from per-question results; "significant" means exactly |paired mean ΔF1| > 95% CI half-width.');
  lines.push('');
  lines.push('## Method');
  lines.push('');
  lines.push('A reader model answers each question from the compressed context only; answers are scored with SQuAD-standard Exact Match and token-level F1 (max over gold aliases where the dataset provides them). Every engine implements the same adapter contract and receives the same questions, matched token budgets (all cells in a ratio group sit at identical achieved compression), and the same reader. Engines that see the question (`*-relevance`, `*-query-aware`) are a separate comparison class from those that do not — compare them against other query-aware engines. Statistics are per-question paired deltas with normal-approximation 95% confidence intervals. Evaluation subsets are seeded, content-hashed, and never used for tuning.');
  lines.push('');

  for (const { report, cells, artifactName } of indexed) {
    lines.push(`# Dataset: ${report.config.dataset}`);
    lines.push('');
    lines.push(...provenanceSection(report, artifactName));
    lines.push('');
    lines.push('## Accuracy frontier');
    lines.push('');
    lines.push(...frontierSection(report, cells));
    lines.push('');
    lines.push('## Head-to-head (paired)');
    lines.push('');
    lines.push(...headToHeadSection(report, cells));
    lines.push('');
    lines.push('## Retention of solvable questions');
    lines.push('');
    lines.push(...retentionSection(report, cells));
    lines.push('');
    const hop = hopSection(report, cells);
    if (hop.length > 0) {
      lines.push(...hop);
    }
  }

  lines.push('# Negative results and limitations');
  lines.push('');
  lines.push(...negativesSection(indexed));
  lines.push('');
  lines.push('# Reproduction');
  lines.push('');
  lines.push('```bash');
  lines.push('cd packages/evals');
  for (const { report } of indexed) {
    const command = report.config.dataset.startsWith('musique')
      ? 'npm run bench -- --config bench.musique.config.json'
      : 'npm run bench';
    lines.push(`${command}          # ${report.config.dataset}`);
  }
  lines.push('npm run bench:report -- bench-results/<artifacts...>');
  lines.push('```');
  lines.push('');
  lines.push(`Requires \`ANTHROPIC_API_KEY\` (reader) and \`npm run bench:setup-llmlingua\` (LLMLingua-2 baseline). Subset selection is seeded — the same config reproduces the same questions on any machine; subset and config hashes above pin exactly what ran.`);
  lines.push('');
  return lines.join('\n');
}

// ─── CLI ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: { out: { type: 'string' } },
    allowPositionals: true,
  });
  if (positionals.length === 0) {
    throw new Error('usage: npm run bench:report -- <artifact.json...> [--out path]');
  }

  const inputs = positionals.map(p => {
    const path = resolve(process.cwd(), p);
    return {
      report: JSON.parse(readFileSync(path, 'utf8')) as BenchReport,
      artifactName: path.split('/').pop()!,
    };
  });

  const markdown = generateBenchmarksMarkdown(inputs);
  if (values.out) {
    const outPath = resolve(process.cwd(), values.out);
    writeFileSync(outPath, markdown);
    console.log(`wrote ${outPath}`);
  } else {
    console.log(markdown);
  }
}

const isDirectRun = process.argv[1]?.endsWith('report-generator.ts') || process.argv[1]?.endsWith('report-generator.js');
if (isDirectRun) {
  main().catch(err => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
