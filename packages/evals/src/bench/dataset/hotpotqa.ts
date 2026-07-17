/**
 * HotpotQA Dataset Loader
 *
 * Fetches the HotpotQA distractor-setting dev split (multi-doc QA: each
 * question ships 10 paragraphs, 2 gold + 8 distractors — the closest
 * public analog to compressing an agent's memory payload) and selects a
 * deterministic evaluation subset.
 *
 * Anti-fudging properties:
 * - The raw file is cached and its subset selection is seeded — same
 *   config, same questions, every run, every machine.
 * - The subset is written to disk and its SHA-256 is embedded in every
 *   report, so results are traceable to exact inputs.
 * - Selection is a seeded shuffle of the FULL dev set (not "the first N",
 *   which would inherit any ordering bias in the file).
 *
 * @module bench/dataset/hotpotqa
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BenchQuestion } from '../types.js';
import { mulberry32 } from '../token-utils.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
/** Cache directory (gitignored) at the evals package root. */
export const BENCH_DATA_DIR = resolve(__dirname, '../../../bench-data');

const RAW_FILE = resolve(BENCH_DATA_DIR, 'hotpot_dev_distractor_v1.json');

interface RawHotpotItem {
  _id: string;
  question: string;
  answer: string;
  /** [title, sentences[]] pairs. */
  context: [string, string[]][];
}

/**
 * Download the raw dev set if not cached. ~45MB, one time.
 */
export async function fetchHotpotQA(datasetUrl: string): Promise<string> {
  if (existsSync(RAW_FILE)) return RAW_FILE;

  mkdirSync(BENCH_DATA_DIR, { recursive: true });
  console.log(`downloading HotpotQA dev (distractor) from ${datasetUrl} (~45MB, cached after first run)...`);
  const res = await fetch(datasetUrl);
  if (!res.ok) {
    throw new Error(`HotpotQA download failed: ${res.status} ${res.statusText}`);
  }
  const body = await res.text();
  writeFileSync(RAW_FILE, body);
  return RAW_FILE;
}

/**
 * Select the deterministic evaluation subset: seeded Fisher-Yates over the
 * full dev set, take the first `size`. Writes the subset to disk and
 * returns it with its SHA-256.
 */
export function selectSubset(
  rawFilePath: string,
  size: number,
  seed: number,
): { questions: BenchQuestion[]; subsetPath: string; subsetHash: string } {
  const raw = JSON.parse(readFileSync(rawFilePath, 'utf8')) as RawHotpotItem[];

  const indices = raw.map((_, i) => i);
  const rng = mulberry32(seed);
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }

  const questions: BenchQuestion[] = indices.slice(0, size).map(i => {
    const item = raw[i];
    return {
      id: item._id,
      question: item.question,
      answer: item.answer,
      documents: item.context.map(([title, sentences]) => ({
        title,
        text: sentences.join(' '),
      })),
    };
  });

  const subsetPath = resolve(BENCH_DATA_DIR, `hotpotqa-subset-${size}-seed${seed}.json`);
  const serialized = JSON.stringify(questions, null, 1);
  writeFileSync(subsetPath, serialized);
  const subsetHash = createHash('sha256').update(serialized).digest('hex');

  return { questions, subsetPath, subsetHash };
}

/**
 * Bundled smoke items for offline iteration and tests. NOT for reporting —
 * three hand-copied HotpotQA-style items, clearly labeled.
 */
export const SMOKE_QUESTIONS: BenchQuestion[] = [
  {
    id: 'smoke-1',
    question: 'In which city is the headquarters of the company that acquired Meridian Systems located?',
    answer: 'Denver',
    documents: [
      { title: 'Meridian Systems', text: 'Meridian Systems is an infrastructure software vendor founded in 2004. The company specializes in workflow orchestration for regulated industries. In 2019 it was acquired by Northgate Holdings.' },
      { title: 'Northgate Holdings', text: 'Northgate Holdings is a private investment group headquartered in Denver. It focuses on enterprise software consolidation and owns a dozen mid-market vendors.' },
      { title: 'Coreline Analytics', text: 'Coreline Analytics is a data platform company based in Austin. It is unrelated to the events above and serves retail customers.' },
      { title: 'Workflow engines', text: 'Workflow engines coordinate multi-step processes. Modern engines use directed graphs, persistent state, and checkpointing to survive failures.' },
    ],
  },
  {
    id: 'smoke-2',
    question: 'What year was the company that employs Dr. Elena Ruiz founded?',
    answer: '1998',
    documents: [
      { title: 'Elena Ruiz', text: 'Dr. Elena Ruiz is a computational linguist known for work on token-efficient serialization. She joined Halcyon Labs as chief scientist after a decade in academia.' },
      { title: 'Halcyon Labs', text: 'Halcyon Labs is a research company founded in 1998. It builds language infrastructure and employs around 300 people across three offices.' },
      { title: 'Token counting', text: 'Token counting estimates how much text fits in a model context window. Character-ratio heuristics achieve five to ten percent error on mixed content.' },
      { title: 'Serialization formats', text: 'Compact serialization formats trade human readability for density. Tabular layouts amortize key names across rows of uniform records.' },
    ],
  },
  {
    id: 'smoke-3',
    question: 'How many nodes does the cluster that runs the Atlas pipeline have?',
    answer: '48',
    documents: [
      { title: 'Atlas pipeline', text: 'The Atlas pipeline is a nightly batch process for entity resolution. It runs on the Foxtrot cluster and completes in roughly four hours.' },
      { title: 'Foxtrot cluster', text: 'Foxtrot is an on-premise compute cluster with 48 nodes. Each node has 512GB of memory, and the scheduler favors long-running batch jobs.' },
      { title: 'Entity resolution', text: 'Entity resolution links records that refer to the same real-world entity. Blocking strategies reduce the quadratic comparison space.' },
      { title: 'Batch scheduling', text: 'Batch schedulers queue jobs by priority and resource requirements. Preemption policies balance throughput against latency guarantees.' },
    ],
  },
];
