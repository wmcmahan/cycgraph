/**
 * Supporting-Doc Survival Harness (tuning-only, reader-free)
 *
 * MuSiQue labels which paragraphs each answer actually needs
 * (`is_supporting`). That makes "did allocation keep the gold evidence?"
 * a DETERMINISTIC question — no reader model, no API cost, no LLM
 * variance. This harness runs the real compression pipeline over a
 * tuning slice and reports, per hop count and ratio:
 *
 * - **full-chain survival**: fraction of questions where EVERY supporting
 *   paragraph survives (retains >= half its characters) — the number that
 *   predicts downstream QA, since losing any hop breaks the chain.
 * - **mean doc survival**: fraction of supporting paragraphs surviving.
 *
 * Tuning protocol (anti-fudging rule #2): the tuning slice uses its own
 * seed AND excludes every question id in the frozen reporting subset
 * (bench.musique.config.json's seed/size). Sweep configs here freely;
 * the reader benchmark on the reporting seed is run ONCE, after the
 * config is frozen.
 *
 * Usage:
 *   npx tsx src/bench/survival.ts                     # default sweep
 *   npx tsx src/bench/survival.ts --items 500 --ratios 0.3,0.5
 *
 * @module bench/survival
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  createPipeline,
  createFormatStage,
  createExactDedupStage,
  createAllocatorStage,
} from '@cycgraph/context-engine';
import type { RelevanceOptions } from '@cycgraph/context-engine';
import type { BenchConfig } from './types.js';
import { countTokens, mulberry32 } from './token-utils.js';
import { fetchMusique, loadMusiqueRaw, selectMusiqueSubset } from './dataset/musique.js';
import type { RawMusiqueItem } from './dataset/musique.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MUSIQUE_CONFIG_PATH = resolve(__dirname, '../../bench.musique.config.json');

/** Tuning seed — deliberately distinct from the reporting seed. */
export const TUNING_SEED = 777003;

/** A PRF configuration under sweep. */
export interface SweepConfig {
  label: string;
  relevance: RelevanceOptions;
}

export interface SurvivalCell {
  config: string;
  ratio: number;
  hop: string;
  questions: number;
  /** Fraction of questions where every supporting paragraph survived. */
  fullChainSurvival: number;
  /** Mean fraction of supporting paragraphs surviving per question. */
  meanDocSurvival: number;
}

/**
 * Select the tuning slice: seeded shuffle with the TUNING seed, minus
 * every id in the frozen reporting subset. Returns `size` items with the
 * dataset's natural hop mix.
 */
export function selectTuningSlice(
  raw: RawMusiqueItem[],
  size: number,
  reportingIds: Set<string>,
): RawMusiqueItem[] {
  const indices = raw.map((_, i) => i);
  const rng = mulberry32(TUNING_SEED);
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  return indices
    .map(i => raw[i])
    .filter(item => !reportingIds.has(item.id))
    .slice(0, size);
}

/** Run one (config, ratio) cell over the slice; aggregate per hop. */
export function runSurvivalCell(
  items: RawMusiqueItem[],
  ratio: number,
  relevance: RelevanceOptions,
  label: string,
): SurvivalCell[] {
  // The shipped fast-preset stage list with the PRF config under test.
  const pipeline = createPipeline({
    stages: [
      createFormatStage(),
      createExactDedupStage(),
      createAllocatorStage({ allocation: 'relevance', relevance }),
    ],
  });

  const byHop = new Map<string, { fullChain: number[]; docSurvival: number[] }>();

  for (const item of items) {
    const segments = item.paragraphs.map(p => ({
      id: `doc-${p.idx}`,
      content: `${p.title}\n${p.paragraph_text}`,
      role: 'history' as const,
      priority: 1,
    }));
    const totalTokens = countTokens(segments.map(s => s.content).join('\n\n'));
    const budget = Math.max(1, Math.ceil(totalTokens * ratio));

    const result = pipeline.compress({
      segments,
      budget: { maxTokens: budget, outputReserve: 0 },
      query: item.question,
    });

    const outLength = new Map(result.segments.map(s => [s.id, s.content.length]));
    const supporting = item.paragraphs.filter(p => p.is_supporting);
    const survived = supporting.filter(p => {
      const original = `${p.title}\n${p.paragraph_text}`.length;
      return (outLength.get(`doc-${p.idx}`) ?? 0) >= original * 0.5;
    });

    const hop = item.id.split('__')[0].replace(/hop\d*$/, 'hop').replace(/^(\d)hop.*/, '$1hop');
    const bucket = byHop.get(hop) ?? { fullChain: [], docSurvival: [] };
    bucket.fullChain.push(survived.length === supporting.length ? 1 : 0);
    bucket.docSurvival.push(supporting.length === 0 ? 1 : survived.length / supporting.length);
    byHop.set(hop, bucket);
  }

  return [...byHop.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([hop, b]) => ({
      config: label,
      ratio,
      hop,
      questions: b.fullChain.length,
      fullChainSurvival: b.fullChain.reduce((x, y) => x + y, 0) / b.fullChain.length,
      meanDocSurvival: b.docSurvival.reduce((x, y) => x + y, 0) / b.docSurvival.length,
    }));
}

// ─── CLI ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      items: { type: 'string', default: '400' },
      ratios: { type: 'string', default: '0.3,0.5' },
    },
    strict: false,
  });
  const size = parseInt(values.items as string, 10);
  const ratios = (values.ratios as string).split(',').map(Number);

  const config = JSON.parse(readFileSync(MUSIQUE_CONFIG_PATH, 'utf8')) as BenchConfig;
  const rawPath = await fetchMusique(config.datasetUrl, config.datasetSha256);
  const raw = loadMusiqueRaw(rawPath);

  // Reporting subset ids to exclude (frozen seed/size from the config).
  const reporting = selectMusiqueSubset(rawPath, config.subsetSize, config.seed);
  const reportingIds = new Set(reporting.questions.map(q => q.id));

  const slice = selectTuningSlice(raw, size, reportingIds);
  const hopMix = new Map<string, number>();
  for (const item of slice) {
    const hop = item.id.replace(/^(\d)hop.*/, '$1hop');
    hopMix.set(hop, (hopMix.get(hop) ?? 0) + 1);
  }
  console.log(`tuning slice: ${slice.length} items (seed ${TUNING_SEED}, reporting subset excluded)`);
  console.log(`hop mix: ${[...hopMix.entries()].sort().map(([h, n]) => `${h}=${n}`).join(' ')}`);
  console.log('');

  const sweep: SweepConfig[] = [
    // Legacy single-round config, spelled out fully — the module defaults
    // are now the tuned config, so `{ prfRounds: 1 }` alone would inherit
    // the new terms/weight.
    { label: 'prf1-t8-w05 (legacy)', relevance: { prfRounds: 1, expansionTerms: 8, expansionWeight: 0.5 } },
    { label: 'default (prf2-t12-w07)', relevance: {} },
    { label: 'prf3-t12-w07', relevance: { prfRounds: 3 } },
  ];

  console.log('| config | ratio | hop | n | full-chain | mean-doc |');
  console.log('|---|---|---|---|---|---|');
  for (const { label, relevance } of sweep) {
    for (const ratio of ratios) {
      for (const cell of runSurvivalCell(slice, ratio, relevance, label)) {
        console.log(
          `| ${cell.config} | ${cell.ratio} | ${cell.hop} | ${cell.questions} | ` +
          `${cell.fullChainSurvival.toFixed(3)} | ${cell.meanDocSurvival.toFixed(3)} |`,
        );
      }
    }
    console.log('|---|---|---|---|---|---|');
  }
}

const isDirectRun = process.argv[1]?.endsWith('survival.ts') || process.argv[1]?.endsWith('survival.js');
if (isDirectRun) {
  main().catch(err => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
