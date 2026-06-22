/**
 * Compound Learning Benchmark — Runnable Example
 *
 * Measures whether a cycgraph workflow gets measurably better at its job
 * across runs, using the reflection → memory → retrieval loop.
 *
 * The setup:
 *
 *   LEARNING condition (5 runs, 5 different topics):
 *     research → critique → reflect
 *     - The researcher writes a brief. It never sees the quality rubric.
 *     - The critic compares the brief against a FIXED rubric and emits
 *       generic, transferable lessons ("Cite named sources with years…").
 *     - The reflection node distills those lessons into memory.
 *     - On the next run, the researcher's `memory_query` injects every
 *       accumulated lesson into its prompt — so run N benefits from the
 *       critiques of runs 1..N-1, on topics it has never seen.
 *
 *   CONTROL condition (same 5 topics, same researcher config):
 *     research only — no critic, no reflection, no memory. This isolates
 *     the learning loop: any score gap is attributable to it, not to the
 *     model or the topics.
 *
 *   SCORING (external to the workflow — the agents never see it):
 *     - structural: 6 deterministic regex/word-count checks against the
 *       rubric. Reproducible without trusting an LLM judge.
 *     - judge: `@cycgraph/evals` multi-sample LLM-as-judge (3 samples,
 *       median) against the same rubric, on a stronger model than the
 *       workers.
 *     - fitness = 0.5 * structural + 0.5 * judge
 *
 * Outputs `results.json` and `chart.svg` next to this file, plus an
 * ASCII chart on stdout.
 *
 * Usage (from the repo root, after `npm run build`):
 *   ANTHROPIC_API_KEY=sk-ant-... npx tsx packages/evals/examples/compound-learning-benchmark/compound-learning-benchmark.ts
 *
 * Approximate cost: under $1 (10 Sonnet worker runs + 30 Opus judge calls).
 */

import {
  GraphRunner,
  InMemoryPersistenceProvider,
  InMemoryAgentRegistry,
  configureAgentFactory,
  createProviderRegistry,
  configureProviderRegistry,
  createGraph,
  createWorkflowState,
} from '@cycgraph/orchestrator';
import type { MemoryWriter, MemoryRetriever, Graph } from '@cycgraph/orchestrator';

import {
  InMemoryMemoryStore,
  InMemoryMemoryIndex,
  retrieveMemory,
} from '@cycgraph/memory';
import type { SemanticFact, Provenance } from '@cycgraph/memory';

import { evaluateMetricMultiSample } from '@cycgraph/evals';
import type { RubricMetric, SemanticJudgeContext } from '@cycgraph/evals';

import { generateText } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ─── 0. Fail fast if no API key ──────────────────────────────────────────

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('Error: ANTHROPIC_API_KEY environment variable is required');
  process.exit(1);
}

const OUT_DIR = dirname(fileURLToPath(import.meta.url));

const WORKER_MODEL = 'claude-sonnet-4-6';
const JUDGE_MODEL = 'claude-opus-4-8';

const LESSON_TAG = 'graph:compound-learning-benchmark-v1';

// Five distinct topics — the workflow can never score well by memorising
// an answer; only the *editorial* lessons transfer between runs.
const TOPICS = [
  'The maturity of WebAssembly for server-side workloads',
  'The state of passwordless authentication adoption in consumer apps',
  'Dedicated vector databases versus Postgres pgvector for production RAG systems',
  'The energy footprint of large language model inference',
  'Supply-chain attack risk in the npm ecosystem',
];

const CONSTRAINTS = ['Write from your own knowledge; do not invent URLs'];

// ─── 1. The fixed quality rubric ─────────────────────────────────────────
// Known to the critic and the external judge. NEVER shown to the researcher
// — the only path from rubric to researcher is critique → reflection →
// memory retrieval.

const RUBRIC = [
  'Cites at least 3 named sources, each with a year in parentheses, e.g. (Cloud Native Computing Foundation, 2024).',
  'Contains a section explicitly titled "Counterarguments" presenting at least 2 substantive counterpoints.',
  'Quantifies at least 3 claims with specific figures (percentages, multiples, or magnitudes such as millions/billions).',
  'States an explicit confidence level (high, medium, or low) for each major conclusion.',
  'Ends with a single line beginning "What would change my mind:" naming concrete evidence that would reverse the thesis.',
  'Total length between 250 and 400 words.',
] as const;

// ─── 2. Deterministic structural scoring (no LLM) ────────────────────────

interface StructuralResult {
  score: number;
  checks: Record<string, boolean>;
}

function scoreStructural(brief: string): StructuralResult {
  const words = brief.trim().split(/\s+/).length;
  const checks: Record<string, boolean> = {
    citations_with_years: (brief.match(/\([^)]*\b(19|20)\d{2}\)/g) ?? []).length >= 3,
    counterarguments_section: /counterarguments?/i.test(brief),
    quantified_claims:
      (brief.match(/\d+(?:\.\d+)?\s*(?:%|percent|x\b|million|billion|trillion)/gi) ?? [])
        .length >= 3,
    confidence_levels: /\b(?:high|medium|low)\s+confidence|confidence[:\s]+(?:high|medium|low)/i.test(brief),
    change_my_mind: /what would change my mind/i.test(brief),
    word_count_in_range: words >= 230 && words <= 440,
  };
  const passed = Object.values(checks).filter(Boolean).length;
  return { score: passed / Object.keys(checks).length, checks };
}

// ─── 3. LLM judge (external — agents never see it) ───────────────────────

const BRIEF_QUALITY: RubricMetric = {
  name: 'brief_quality',
  buildPrompt(ctx: SemanticJudgeContext): string {
    return [
      'You are an evaluation judge. Score a research brief against a fixed quality rubric.',
      '',
      `Topic: ${ctx.input}`,
      '',
      'Rubric (each item is worth equal weight):',
      ...RUBRIC.map((item, i) => `${i + 1}. ${item}`),
      '',
      `Brief to evaluate:\n${ctx.actualOutput}`,
      '',
      'Score from 0.0 to 1.0 as the fraction of rubric items the brief fully satisfies,',
      'adjusted down for items that are only superficially satisfied (e.g. a "Counterarguments"',
      'heading with no substantive counterpoints under it).',
      '',
      'Respond with ONLY a JSON object: {"score": <number>, "reasoning": "<explanation>"}',
    ].join('\n');
  },
};

// Note: no temperature param — it is not accepted on Opus 4.7+ models.
async function callJudge(prompt: string): Promise<string> {
  const { text } = await generateText({
    model: anthropic(JUDGE_MODEL),
    prompt,
    maxOutputTokens: 600,
  });
  return text;
}

// ─── 4. Memory store + writer + retriever ────────────────────────────────

const memoryStore = new InMemoryMemoryStore();
const memoryIndex = new InMemoryMemoryIndex();

const memoryWriter: MemoryWriter = async (facts) => {
  const now = new Date();
  const ids: string[] = [];
  for (const fact of facts) {
    const provenance: Provenance = {
      source: fact.provenance.source,
      created_at: now,
      run_id: fact.provenance.run_id,
      node_id: fact.provenance.node_id,
    };
    const stored: SemanticFact = {
      id: crypto.randomUUID(),
      content: fact.content,
      source_episode_ids: [],
      entity_ids: [],
      provenance,
      valid_from: now,
      tags: fact.tags,
    };
    await memoryStore.putFact(stored);
    ids.push(stored.id);
  }
  return { fact_ids: ids };
};

const memoryRetriever: MemoryRetriever = async (query, options) => {
  const result = await retrieveMemory(memoryStore, memoryIndex, {
    tags: query.tags ?? [LESSON_TAG],
    max_hops: 0,
    limit: options?.maxFacts ?? 40,
    min_similarity: 0,
    include_invalidated: false,
  });
  return {
    facts: result.facts.map((f) => ({ content: f.content, validFrom: f.valid_from })),
    entities: [],
    themes: [],
  };
};

async function countLessons(): Promise<number> {
  const facts = await memoryStore.findFacts({ include_invalidated: false, limit: 1000 });
  return facts.filter((f) => f.tags.includes(LESSON_TAG)).length;
}

// ─── 5. Register agents ──────────────────────────────────────────────────

const registry = new InMemoryAgentRegistry();

// The researcher's base prompt is deliberately generic — it has no idea the
// rubric exists. Everything it learns about quality arrives via memory.
const RESEARCHER_ID = registry.register({
  name: 'Research Analyst',
  description: 'Writes research briefs from model knowledge',
  model: WORKER_MODEL,
  provider: 'anthropic',
  systemPrompt: [
    'You are a research analyst. Write a research brief on the given topic',
    'from your own knowledge. Be concrete and specific.',
    'When the prompt contains a "## Relevant Memory" section, honour every',
    'lesson in it — each one was distilled from an editor\'s critique of your',
    'previous briefs, and applies to this brief even though the topic differs.',
    'Output only the brief itself, no preamble.',
  ].join(' '),
  temperature: 0.4,
  maxSteps: 3,
  tools: [],
  permissions: {
    readKeys: ['goal', 'constraints'],
    writeKeys: ['research_brief'],
  },
});

// The critic holds the rubric and converts gaps into transferable lessons.
const CRITIC_ID = registry.register({
  name: 'Research Editor',
  description: 'Critiques briefs against a fixed rubric, emitting lessons',
  model: WORKER_MODEL,
  provider: 'anthropic',
  systemPrompt: [
    'You are an exacting research editor. Evaluate the research brief you',
    'receive against this fixed rubric:',
    ...RUBRIC.map((item, i) => `${i + 1}. ${item}`),
    'Output ONLY lessons for the author to apply to all future briefs:',
    'one lesson per line, each a single self-contained imperative sentence of',
    '20 to 50 words ending with a period. Do not number or bullet the lines.',
    'Each lesson must target a rubric item the brief missed or satisfied only',
    'superficially, must be generic enough to apply to any topic, and must',
    'never mention the current topic. If the brief fully satisfies an item,',
    'write no lesson for it. If the brief satisfies everything, output exactly:',
    'No corrections; maintain the current standard of sourcing, quantification, counterarguments, confidence labelling, and length.',
  ].join(' '),
  temperature: 0.2,
  maxSteps: 3,
  tools: [],
  permissions: {
    readKeys: ['research_brief'],
    writeKeys: ['critique'],
  },
});

configureAgentFactory(registry);
configureProviderRegistry(createProviderRegistry());

// ─── 6. Graphs ───────────────────────────────────────────────────────────

const learningGraph = createGraph({
  name: 'Compound Learning Benchmark — learning condition',
  description: 'research → critique → reflect, with lesson retrieval',
  nodes: [
    {
      id: 'research',
      type: 'agent',
      agentId: RESEARCHER_ID,
      readKeys: ['goal', 'constraints'],
      writeKeys: ['research_brief'],
      memoryQuery: { tags: [LESSON_TAG], maxFacts: 40 },
      failurePolicy: {
        maxRetries: 2,
        backoffStrategy: 'exponential',
        initialBackoffMs: 1000,
        maxBackoffMs: 60000,
      },
      requiresCompensation: false,
    },
    {
      id: 'critique',
      type: 'agent',
      agentId: CRITIC_ID,
      readKeys: ['research_brief'],
      writeKeys: ['critique'],
      failurePolicy: {
        maxRetries: 2,
        backoffStrategy: 'exponential',
        initialBackoffMs: 1000,
        maxBackoffMs: 60000,
      },
      requiresCompensation: false,
    },
    {
      id: 'reflect',
      type: 'reflection',
      readKeys: ['critique'],
      writeKeys: ['reflect_reflection'],
      reflectionConfig: {
        sourceKeys: ['critique'],
        extractor: { type: 'rule_based', minSentenceLength: 25 },
        tags: ['lesson', LESSON_TAG],
      },
      failurePolicy: {
        maxRetries: 1,
        backoffStrategy: 'exponential',
        initialBackoffMs: 500,
        maxBackoffMs: 5000,
      },
      requiresCompensation: false,
    },
  ],
  edges: [
    { source: 'research', target: 'critique' },
    { source: 'critique', target: 'reflect' },
  ],
  startNode: 'research',
  endNodes: ['reflect'],
});

const controlGraph = createGraph({
  name: 'Compound Learning Benchmark — control condition',
  description: 'research only: same agent, no critic, no memory',
  nodes: [
    {
      id: 'research',
      type: 'agent',
      agentId: RESEARCHER_ID,
      readKeys: ['goal', 'constraints'],
      writeKeys: ['research_brief'],
      failurePolicy: {
        maxRetries: 2,
        backoffStrategy: 'exponential',
        initialBackoffMs: 1000,
        maxBackoffMs: 60000,
      },
      requiresCompensation: false,
    },
  ],
  edges: [],
  startNode: 'research',
  endNodes: ['research'],
});

// ─── 7. Run + score one workflow ─────────────────────────────────────────

interface RunRecord {
  run: number;
  mode: 'learning' | 'control';
  topic: string;
  fitness: number;
  structural: number;
  judge_median: number;
  judge_samples: number[];
  judge_stable: boolean;
  structural_checks: Record<string, boolean>;
  lessons_injected: number;
  lessons_in_store_after: number;
  tokens_used: number;
  cost_usd: number;
  brief: string;
}

async function runOnce(
  graph: Graph,
  topic: string,
  mode: 'learning' | 'control',
  runNumber: number,
): Promise<RunRecord> {
  const lessonsBefore = await countLessons();

  const initialState = createWorkflowState({
    workflowId: graph.id,
    goal: `Write a research brief on: ${topic}`,
    constraints: [...CONSTRAINTS],
    maxExecutionTimeMs: 180_000,
  });

  const persistence = new InMemoryPersistenceProvider();
  const runner = new GraphRunner(graph, initialState, {
    persistStateFn: async (state) => {
      await persistence.saveWorkflowState(state);
      await persistence.saveWorkflowRun(state);
    },
    ...(mode === 'learning' ? { memoryWriter, memoryRetriever } : {}),
  });

  const finalState = await runner.run();
  if (finalState.status !== 'completed') {
    throw new Error(`workflow ended in ${finalState.status}: ${finalState.last_error}`);
  }

  const brief = String(finalState.memory.research_brief ?? '');

  const structural = scoreStructural(brief);
  const judge = await evaluateMetricMultiSample(
    { input: topic, actualOutput: brief },
    BRIEF_QUALITY,
    callJudge,
    { samples: 3, threshold: 0.8 },
  );

  const fitness = 0.5 * structural.score + 0.5 * judge.median;

  return {
    run: runNumber,
    mode,
    topic,
    fitness,
    structural: structural.score,
    judge_median: judge.median,
    judge_samples: judge.samples,
    judge_stable: judge.stable,
    structural_checks: structural.checks,
    lessons_injected: mode === 'learning' ? lessonsBefore : 0,
    lessons_in_store_after: await countLessons(),
    tokens_used: finalState.total_tokens_used,
    cost_usd: finalState.total_cost_usd,
    brief,
  };
}

// ─── 8. Charts ───────────────────────────────────────────────────────────

function asciiChart(learning: RunRecord[], control: RunRecord[]): string {
  const lines: string[] = ['', 'Fitness per run  (█ learning   ░ control)', ''];
  for (let i = 0; i < learning.length; i++) {
    const l = learning[i];
    const c = control[i];
    const lBar = '█'.repeat(Math.round(l.fitness * 40)).padEnd(40);
    const cBar = '░'.repeat(Math.round(c.fitness * 40)).padEnd(40);
    lines.push(`run ${l.run}  learning ${lBar} ${l.fitness.toFixed(2)}`);
    lines.push(`       control  ${cBar} ${c.fitness.toFixed(2)}`);
    lines.push('');
  }
  return lines.join('\n');
}

function svgChart(learning: RunRecord[], control: RunRecord[]): string {
  const W = 720;
  const H = 420;
  const PAD = { top: 56, right: 32, bottom: 56, left: 56 };
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const n = learning.length;

  const x = (i: number) => PAD.left + (i / (n - 1)) * plotW;
  const y = (score: number) => PAD.top + (1 - score) * plotH;

  const poly = (records: RunRecord[]) =>
    records.map((r, i) => `${x(i).toFixed(1)},${y(r.fitness).toFixed(1)}`).join(' ');

  const dots = (records: RunRecord[], color: string) =>
    records
      .map(
        (r, i) =>
          `<circle cx="${x(i).toFixed(1)}" cy="${y(r.fitness).toFixed(1)}" r="4" fill="${color}"/>` +
          `<text x="${x(i).toFixed(1)}" y="${(y(r.fitness) - 10).toFixed(1)}" text-anchor="middle" font-size="11" fill="${color}">${r.fitness.toFixed(2)}</text>`,
      )
      .join('\n  ');

  const gridlines = [0, 0.25, 0.5, 0.75, 1]
    .map(
      (v) =>
        `<line x1="${PAD.left}" y1="${y(v)}" x2="${W - PAD.right}" y2="${y(v)}" stroke="#e5e5e5"/>` +
        `<text x="${PAD.left - 8}" y="${y(v) + 4}" text-anchor="end" font-size="11" fill="#888">${v.toFixed(2)}</text>`,
    )
    .join('\n  ');

  const xLabels = learning
    .map(
      (r, i) =>
        `<text x="${x(i).toFixed(1)}" y="${H - PAD.bottom + 20}" text-anchor="middle" font-size="11" fill="#888">run ${r.run}</text>`,
    )
    .join('\n  ');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="ui-sans-serif, system-ui, sans-serif">
  <rect width="${W}" height="${H}" fill="white"/>
  <text x="${PAD.left}" y="28" font-size="15" font-weight="600" fill="#222">Same model, same topics — one workflow learns, one doesn't</text>
  <text x="${PAD.left}" y="44" font-size="12" fill="#777">fitness = 0.5 × deterministic rubric checks + 0.5 × LLM-judge median (3 samples)</text>
  ${gridlines}
  ${xLabels}
  <polyline points="${poly(control)}" fill="none" stroke="#9ca3af" stroke-width="2" stroke-dasharray="5,4"/>
  <polyline points="${poly(learning)}" fill="none" stroke="#059669" stroke-width="2.5"/>
  ${dots(control, '#9ca3af')}
  ${dots(learning, '#059669')}
  <g font-size="12">
    <line x1="${W - 230}" y1="${PAD.top}" x2="${W - 206}" y2="${PAD.top}" stroke="#059669" stroke-width="2.5"/>
    <text x="${W - 200}" y="${PAD.top + 4}" fill="#222">with reflection + memory</text>
    <line x1="${W - 230}" y1="${PAD.top + 20}" x2="${W - 206}" y2="${PAD.top + 20}" stroke="#9ca3af" stroke-width="2" stroke-dasharray="5,4"/>
    <text x="${W - 200}" y="${PAD.top + 24}" fill="#222">no learning (control)</text>
  </g>
</svg>
`;
}

// ─── 9. Main ─────────────────────────────────────────────────────────────

async function main() {
  console.log('Compound Learning Benchmark');
  console.log(`worker model: ${WORKER_MODEL}   judge model: ${JUDGE_MODEL}\n`);

  const learning: RunRecord[] = [];
  for (let i = 0; i < TOPICS.length; i++) {
    console.log(`[learning ${i + 1}/${TOPICS.length}] ${TOPICS[i]}`);
    const record = await runOnce(learningGraph, TOPICS[i], 'learning', i + 1);
    learning.push(record);
    console.log(
      `  fitness=${record.fitness.toFixed(2)} (structural=${record.structural.toFixed(2)}, judge=${record.judge_median.toFixed(2)})` +
        `  lessons injected=${record.lessons_injected}, in store=${record.lessons_in_store_after}`,
    );
  }

  const control: RunRecord[] = [];
  for (let i = 0; i < TOPICS.length; i++) {
    console.log(`[control  ${i + 1}/${TOPICS.length}] ${TOPICS[i]}`);
    const record = await runOnce(controlGraph, TOPICS[i], 'control', i + 1);
    control.push(record);
    console.log(
      `  fitness=${record.fitness.toFixed(2)} (structural=${record.structural.toFixed(2)}, judge=${record.judge_median.toFixed(2)})`,
    );
  }

  console.log(asciiChart(learning, control));

  const learningAvg = learning.reduce((s, r) => s + r.fitness, 0) / learning.length;
  const controlAvg = control.reduce((s, r) => s + r.fitness, 0) / control.length;
  const firstToLast = learning[learning.length - 1].fitness - learning[0].fitness;
  const totalCost = [...learning, ...control].reduce((s, r) => s + r.cost_usd, 0);

  console.log(`learning avg fitness: ${learningAvg.toFixed(3)}   control avg: ${controlAvg.toFixed(3)}`);
  console.log(`learning run 1 → run ${learning.length}: ${learning[0].fitness.toFixed(2)} → ${learning[learning.length - 1].fitness.toFixed(2)} (${firstToLast >= 0 ? '+' : ''}${firstToLast.toFixed(2)})`);
  console.log(`total workflow cost: $${totalCost.toFixed(4)} (judge calls billed separately)`);

  const results = {
    worker_model: WORKER_MODEL,
    judge_model: JUDGE_MODEL,
    rubric: RUBRIC,
    topics: TOPICS,
    learning,
    control,
    summary: {
      learning_avg_fitness: learningAvg,
      control_avg_fitness: controlAvg,
      learning_first_to_last_delta: firstToLast,
    },
  };

  writeFileSync(join(OUT_DIR, 'results.json'), JSON.stringify(results, null, 2));
  writeFileSync(join(OUT_DIR, 'chart.svg'), svgChart(learning, control));
  console.log(`\nWrote ${join(OUT_DIR, 'results.json')}`);
  console.log(`Wrote ${join(OUT_DIR, 'chart.svg')}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
