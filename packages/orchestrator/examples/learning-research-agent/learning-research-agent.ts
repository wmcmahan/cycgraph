/**
 * Learning Research Agent — Runnable Example
 *
 * Demonstrates compound learning across workflow runs using the
 * `reflection` node + `MemoryWriter` + `MemoryRetriever`.
 *
 * The same graph runs twice on related goals. After run 1 the reflection
 * node distills the researcher's notes into atomic lessons and writes
 * them to an `@cycgraph/memory` store. On run 2 the researcher node's
 * `memory_query` directive causes the runner to call `memoryRetriever`
 * before prompt construction; the returned lessons are rendered into a
 * `## Relevant Memory` section of the system prompt. Agents compound
 * knowledge with zero manual injection.
 *
 * Demonstrates:
 * - `reflection` node with `rule_based` extractor
 * - `MemoryWriter` adapter wired to `InMemoryMemoryStore`
 * - `MemoryRetriever` adapter using tag-only `retrieveMemory()`
 * - Per-node `memory_query: { tags }` directive
 * - Side-by-side comparison of run 1 vs run 2 outcomes
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/learning-research-agent/learning-research-agent.ts
 *
 * Production swap: replace `InMemoryMemoryStore` with `DrizzleMemoryStore`
 * from `@cycgraph/orchestrator-postgres` and lessons survive restarts.
 */

import {
  GraphRunner,
  InMemoryPersistenceProvider,
  InMemoryAgentRegistry,
  configureAgentFactory,
  createProviderRegistry,
  configureProviderRegistry,
  createLogger,
  createGraph,
  createWorkflowState,
} from '@cycgraph/orchestrator';
import type {
  MemoryWriter,
  MemoryRetriever,
} from '@cycgraph/orchestrator';

import {
  InMemoryMemoryStore,
  InMemoryMemoryIndex,
  retrieveMemory,
} from '@cycgraph/memory';
import type { SemanticFact, Provenance } from '@cycgraph/memory';

// ─── 0. Fail fast if no API key ──────────────────────────────────────────

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('Error: ANTHROPIC_API_KEY environment variable is required');
  console.error(
    'Usage: ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/learning-research-agent/learning-research-agent.ts',
  );
  process.exit(1);
}

const logger = createLogger('learning-research');

// Tag used by the reflection node and the in-loop retrieval — the
// namespace keeps lessons from this graph distinct from lessons from
// other graphs sharing the same memory store.
const LESSON_TAG = 'graph:learning-research-v1';

// ─── 1. Memory store + writer ───────────────────────────────────────────

const memoryStore = new InMemoryMemoryStore();
const memoryIndex = new InMemoryMemoryIndex();

/**
 * `MemoryWriter` adapter — translates orchestrator's `MemoryWriterFact[]`
 * into `@cycgraph/memory`'s `SemanticFact` shape and persists each one.
 * In production this lives behind a `DrizzleMemoryStore` and survives
 * process restarts.
 */
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

/**
 * `MemoryRetriever` adapter — pulls lessons tagged with this graph's
 * namespace. The runner invokes this before building the researcher's
 * system prompt because the researcher node carries `memory_query`.
 */
const memoryRetriever: MemoryRetriever = async (query, options) => {
  const result = await retrieveMemory(memoryStore, memoryIndex, {
    tags: query.tags ?? [LESSON_TAG],
    maxHops: 0,
    limit: options?.maxFacts ?? 20,
    minSimilarity: 0,
    includeInvalidated: false,
  });
  return {
    facts: result.facts.map((f) => ({ content: f.content, validFrom: f.valid_from })),
    entities: result.entities.map((e) => ({ name: e.name, type: e.entity_type })),
    themes: result.themes.map((t) => ({ label: t.label })),
  };
};

// ─── 2. Register agents ─────────────────────────────────────────────────

const registry = new InMemoryAgentRegistry();

const RESEARCHER_ID = registry.register({
  name: 'Research Agent',
  description: 'Gathers concise research notes on a topic',
  model: 'claude-sonnet-4-6',
  provider: 'anthropic',
  systemPrompt: [
    'You are a research specialist.',
    'Given a goal, produce 5–8 bullet-style research notes.',
    'Each bullet is a single, self-contained sentence (25–60 words).',
    'When the prompt contains a "## Relevant Memory" section with prior lessons,',
    'honour them — they were distilled from previous research runs.',
    'When you apply a lesson, cite it by quoting a key phrase in parentheses.',
  ].join(' '),
  temperature: 0.5,
  maxSteps: 3,
  tools: [],
  permissions: {
    readKeys: ['goal', 'constraints'],
    writeKeys: ['research_notes'],
  },
});

configureAgentFactory(registry);
configureProviderRegistry(createProviderRegistry());

// ─── 3. Define the graph ────────────────────────────────────────────────

const graph = createGraph({
  name: 'Learning Research Agent',
  description: 'Research node followed by a reflection node that compounds lessons across runs',

  nodes: [
    {
      id: 'research',
      type: 'agent',
      agentId: RESEARCHER_ID,
      readKeys: ['goal', 'constraints'],
      writeKeys: ['research_notes'],
      // Per-node memory retrieval directive. The runner calls
      // `memoryRetriever({ tags: [LESSON_TAG] }, …)` before building this
      // node's prompt and renders the result into a `## Relevant Memory`
      // section. Zero manual injection required.
      memoryQuery: {
        tags: [LESSON_TAG],
        maxFacts: 20,
      },
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
      readKeys: ['research_notes'],
      writeKeys: ['research_notes_reflection'],
      reflectionConfig: {
        sourceKeys: ['research_notes'],
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
    { source: 'research', target: 'reflect' },
  ],

  startNode: 'research',
  endNodes: ['reflect'],
});

// ─── 4. Run helper ──────────────────────────────────────────────────────

interface RunOutcome {
  goal: string;
  research_notes: string;
  lessons_injected: number;
  lessons_extracted: number;
  tokens_used: number;
  cost_usd: number;
  duration_ms: number;
}

async function countLessons(): Promise<number> {
  const facts = await memoryStore.findFacts({ includeInvalidated: false, limit: 1000 });
  return facts.filter((f) => f.tags.includes(LESSON_TAG)).length;
}

async function runOnce(goal: string, constraints: string[]): Promise<RunOutcome> {
  const priorLessonCount = await countLessons();

  const initialState = createWorkflowState({
    workflowId: graph.id,
    goal,
    constraints,
    maxExecutionTimeMs: 120_000,
  });

  const persistence = new InMemoryPersistenceProvider();
  const runner = new GraphRunner(graph, initialState, {
    persistStateFn: async (state) => {
      await persistence.saveWorkflowState(state);
      await persistence.saveWorkflowRun(state);
    },
    memoryWriter,
    memoryRetriever,
  });

  const startedAt = Date.now();
  const finalState = await runner.run();
  const duration = Date.now() - startedAt;

  if (finalState.status !== 'completed') {
    throw new Error(`workflow ended in ${finalState.status}: ${finalState.last_error}`);
  }

  const envelope = finalState.memory.research_notes_reflection as
    | { fact_ids?: string[] }
    | undefined;

  return {
    goal,
    research_notes: String(finalState.memory.research_notes ?? ''),
    lessons_injected: priorLessonCount,
    lessons_extracted: envelope?.fact_ids?.length ?? 0,
    tokens_used: finalState.total_tokens_used,
    cost_usd: finalState.total_cost_usd,
    duration_ms: duration,
  };
}

// ─── 5. Main: run twice and compare ─────────────────────────────────────

async function main() {
  logger.info('Starting learning-research-agent example\n');

  const run1 = await runOnce(
    'Research best practices for evaluating the credibility of scientific sources.',
    ['Keep notes concise', 'Focus on actionable rules'],
  );
  printRun('RUN 1 (no prior knowledge)', run1);

  const facts = await memoryStore.findFacts({ includeInvalidated: false, limit: 100 });
  const lessonFacts = facts.filter((f) => f.tags.includes(LESSON_TAG));
  console.log(
    `\n  Memory store now contains ${lessonFacts.length} lesson facts tagged '${LESSON_TAG}'.`,
  );

  const run2 = await runOnce(
    'Research best practices for evaluating the credibility of news sources.',
    ['Keep notes concise', 'Focus on actionable rules'],
  );
  printRun('RUN 2 (with lessons from run 1)', run2);

  console.log('\n═══ Comparison ═══');
  console.log(
    `  Lessons injected:    run1=${run1.lessons_injected}  run2=${run2.lessons_injected}`,
  );
  console.log(
    `  Lessons extracted:   run1=${run1.lessons_extracted}  run2=${run2.lessons_extracted}`,
  );
  console.log(`  Tokens used:         run1=${run1.tokens_used}  run2=${run2.tokens_used}`);
  console.log(
    `  Cost (USD):          run1=$${run1.cost_usd.toFixed(4)}  run2=$${run2.cost_usd.toFixed(4)}`,
  );
  console.log(`  Duration:            run1=${run1.duration_ms}ms  run2=${run2.duration_ms}ms`);

  console.log(
    '\n  The expected pattern: run 2 references prior lessons in parentheses,',
  );
  console.log('  showing the researcher acted on retained knowledge from run 1.');
}

function printRun(label: string, outcome: RunOutcome): void {
  console.log(`\n═══ ${label} ═══`);
  console.log(`Goal:               ${outcome.goal}`);
  console.log(`Lessons injected:   ${outcome.lessons_injected}`);
  console.log(`Lessons extracted:  ${outcome.lessons_extracted}`);
  console.log(`Tokens used:        ${outcome.tokens_used}`);
  console.log(`\n--- Research notes ---`);
  console.log(outcome.research_notes);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
