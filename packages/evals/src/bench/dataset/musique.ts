/**
 * MuSiQue Dataset Loader
 *
 * Fetches the MuSiQue-Ans dev split (answerable variant) and selects a
 * deterministic evaluation subset. MuSiQue is the cross-segment stress
 * test the harness needs beyond HotpotQA: 2-4 hop questions over 20
 * paragraphs (vs HotpotQA's 2 gold of 10), constructed specifically to
 * defeat single-paragraph shortcuts — gold evidence genuinely spans up
 * to 4 segments, so whole-segment allocation can't win by picking one
 * lucky document.
 *
 * Dev split composition (2417 questions): 1252 2-hop, 760 3-hop, 405
 * 4-hop. A seeded shuffle preserves that mix proportionally in the
 * subset. Question ids encode hop count (`2hop__...`), so per-hop
 * breakdowns can be recovered from raw results without extra fields.
 *
 * Anti-fudging properties (same contract as the HotpotQA loader):
 * - The download URL pins an immutable HuggingFace revision, and the
 *   file's SHA-256 is verified against the config's `datasetSha256`
 *   (the LFS object hash) — the raw data provably is what we say it is.
 * - Subset selection is a seeded shuffle of the FULL dev set; the subset
 *   is written to disk and its SHA-256 is embedded in every report.
 * - `answer_aliases` are carried through so scoring can take the max
 *   over golds (the official MuSiQue protocol) instead of quietly
 *   penalizing correct alternate surface forms.
 *
 * @module bench/dataset/musique
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { BenchQuestion } from '../types.js';
import { mulberry32 } from '../token-utils.js';
import { BENCH_DATA_DIR } from './hotpotqa.js';

const RAW_FILE = resolve(BENCH_DATA_DIR, 'musique_ans_v1.0_dev.jsonl');

export interface RawMusiqueItem {
  id: string;
  question: string;
  answer: string;
  answer_aliases: string[];
  answerable: boolean;
  paragraphs: Array<{
    idx: number;
    title: string;
    paragraph_text: string;
    is_supporting: boolean;
  }>;
}

/**
 * Load the full raw dev set with `is_supporting` labels intact.
 *
 * For the SUPPORTING-DOC SURVIVAL harness only — the labels say which
 * paragraphs the answer actually needs, enabling a deterministic,
 * reader-free measure of whether allocation kept the gold evidence.
 * NEVER thread these labels into `BenchQuestion`: an adapter that can see
 * them can cheat the benchmark.
 */
export function loadMusiqueRaw(rawFilePath: string): RawMusiqueItem[] {
  return readFileSync(rawFilePath, 'utf8')
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as RawMusiqueItem)
    .filter(item => item.answerable);
}

/**
 * Download the raw dev split if not cached (~30MB, one time). When
 * `expectedSha256` is provided, the file content is verified against it
 * (both cached and freshly downloaded) — a mismatch is a hard error, not
 * a warning, because every downstream number depends on this file.
 */
export async function fetchMusique(
  datasetUrl: string,
  expectedSha256?: string,
): Promise<string> {
  if (!existsSync(RAW_FILE)) {
    mkdirSync(BENCH_DATA_DIR, { recursive: true });
    console.log(`downloading MuSiQue-Ans dev from ${datasetUrl} (~30MB, cached after first run)...`);
    const res = await fetch(datasetUrl);
    if (!res.ok) {
      throw new Error(`MuSiQue download failed: ${res.status} ${res.statusText}`);
    }
    writeFileSync(RAW_FILE, await res.text());
  }

  if (expectedSha256 !== undefined) {
    const actual = createHash('sha256').update(readFileSync(RAW_FILE)).digest('hex');
    if (actual !== expectedSha256) {
      throw new Error(
        `MuSiQue dataset hash mismatch: expected ${expectedSha256}, got ${actual}. ` +
        `Delete ${RAW_FILE} and re-run to re-download.`,
      );
    }
  }
  return RAW_FILE;
}

/**
 * Select the deterministic evaluation subset: seeded Fisher-Yates over
 * the full dev set, take the first `size`. Writes the subset to disk and
 * returns it with its SHA-256. Mirrors the HotpotQA loader's contract so
 * the runner treats both datasets identically.
 */
export function selectMusiqueSubset(
  rawFilePath: string,
  size: number,
  seed: number,
): { questions: BenchQuestion[]; subsetPath: string; subsetHash: string } {
  // The -Ans file is all answerable; loadMusiqueRaw's filter guards
  // against ever pointing the config at the -Full variant by mistake.
  const raw = loadMusiqueRaw(rawFilePath);

  const indices = raw.map((_, i) => i);
  const rng = mulberry32(seed);
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }

  const questions: BenchQuestion[] = indices.slice(0, size).map(i => {
    const item = raw[i];
    return {
      id: item.id,
      question: item.question,
      answer: item.answer,
      answerAliases: item.answer_aliases.filter(a => a.trim().length > 0),
      documents: item.paragraphs.map(p => ({
        title: p.title,
        text: p.paragraph_text,
      })),
    };
  });

  const subsetPath = resolve(BENCH_DATA_DIR, `musique-subset-${size}-seed${seed}.json`);
  const serialized = JSON.stringify(questions, null, 1);
  writeFileSync(subsetPath, serialized);
  const subsetHash = createHash('sha256').update(serialized).digest('hex');

  return { questions, subsetPath, subsetHash };
}
