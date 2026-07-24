/**
 * Context Engine + Memory — Runnable Example
 *
 * A supervisor-routed workflow that demonstrates persistent memory
 * and context compression working together. A Research agent gathers
 * notes that are stored in the memory hierarchy, then a Writer agent
 * receives compressed, relevant memory facts in its prompt.
 *
 * Demonstrates:
 * - @cycgraph/memory: episode segmentation, rule-based fact extraction,
 *   theme clustering, hierarchical retrieval, conflict detection,
 *   and memory consolidation
 * - @cycgraph/context-engine: incremental compression pipeline with
 *   format compression, fuzzy dedup, and budget allocation
 * - Orchestrator integration via contextCompressor + memoryRetriever
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/context-and-memory/context-and-memory.ts
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
import type { ContextCompressor } from '@cycgraph/orchestrator';
import type { MemoryRetriever } from '@cycgraph/orchestrator';

import {
  InMemoryMemoryStore,
  InMemoryMemoryIndex,
  SimpleEpisodeSegmenter,
  RuleBasedExtractor,
  ConsolidatingThemeClusterer,
  MemoryConsolidator,
  ConflictDetector,
  retrieveMemory,
} from '@cycgraph/memory';
import type { Message } from '@cycgraph/memory';

import {
  createIncrementalPipeline,
  createFormatStage,
  createExactDedupStage,
  createFuzzyDedupStage,
  createAllocatorStage,
  serialize,
} from '@cycgraph/context-engine';
import type { PipelineState } from '@cycgraph/context-engine';

// ─── 0. Fail fast if no API key ──────────────────────────────────────────

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('Error: ANTHROPIC_API_KEY environment variable is required');
  console.error('Usage: ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/context-and-memory/context-and-memory.ts');
  process.exit(1);
}

const logger = createLogger('example');

// ─── 1. Set up the memory system ────────────────────────────────────────
// In-memory implementations for the example. Production would use
// DrizzleMemoryStore / DrizzleMemoryIndex from @cycgraph/orchestrator-postgres.

const memoryStore = new InMemoryMemoryStore();
const memoryIndex = new InMemoryMemoryIndex();
const segmenter = new SimpleEpisodeSegmenter({ gap_threshold_ms: 5 * 60 * 1000 });
const extractor = new RuleBasedExtractor({ minSentenceLength: 15 });
const clusterer = new ConsolidatingThemeClusterer({
  assignmentThreshold: 0.7,
  mergeThreshold: 0.85,
  maxThemes: 20,
});

/**
 * Ingest a batch of messages into the memory hierarchy.
 * Segments → episodes → facts → themes, then rebuilds the search index.
 */
async function ingestMessages(messages: Message[]): Promise<void> {
  // Segment messages into topic-coherent episodes
  const episodes = await segmenter.segment(messages);
  for (const ep of episodes) {
    await memoryStore.putEpisode(ep);

    // Extract atomic facts and entities from each episode. Tag each
    // fact with PRIOR_KNOWLEDGE_TAG so the agent nodes' `memory_query`
    // can scope retrieval to this seeded corpus.
    const result = await extractor.extract(ep);
    for (const fact of result.facts) {
      await memoryStore.putFact({ ...fact, tags: [PRIOR_KNOWLEDGE_TAG] });
    }
    for (const entity of result.entities) {
      await memoryStore.putEntity(entity);
    }
    for (const relationship of result.relationships) {
      await memoryStore.putRelationship(relationship);
    }
  }

  // Cluster facts into themes
  const allFacts = await memoryStore.findFacts();
  const existingThemes = await memoryStore.listThemes();
  const themes = await clusterer.cluster(allFacts, existingThemes);
  for (const theme of themes) {
    await memoryStore.putTheme(theme);
  }

  // Rebuild the search index
  await memoryIndex.rebuild(memoryStore);
}

// ─── 2. Set up the context compression pipeline ─────────────────────────
// Incremental pipeline caches unchanged segments between turns.
// Uses format compression, dedup, and budget allocation.

const compressionPipeline = createIncrementalPipeline({
  stages: [
    createFormatStage(),
    createExactDedupStage(),
    createFuzzyDedupStage({ threshold: 0.85 }),
    createAllocatorStage(),
  ],
  logger: { warn: (msg) => logger.warn(msg) },
  timeoutMs: 500, // hard cap to prevent runaway compression
});

let pipelineState: PipelineState | undefined;

// ─── 3. Wire adapters for the orchestrator ──────────────────────────────

/**
 * Context compressor: compresses memory data before injecting into prompts.
 * Uses the incremental pipeline so subsequent calls benefit from caching.
 */
const contextCompressor: ContextCompressor = (sanitizedMemory, options) => {
  const content = serialize(sanitizedMemory);

  const { result, state: nextState } = compressionPipeline.compress(
    {
      segments: [{
        id: 'memory',
        content,
        role: 'memory' as const,
        priority: 1,
        locked: false,
      }],
      budget: {
        maxTokens: options?.maxTokens ?? 8192,
        outputReserve: 0,
      },
      model: options?.model,
    },
    pipelineState,
  );
  pipelineState = nextState;

  return {
    compressed: result.segments[0].content,
    metrics: {
      totalTokensIn: result.metrics.totalTokensIn,
      totalTokensOut: result.metrics.totalTokensOut,
      reductionPercent: result.metrics.reductionPercent,
      totalDurationMs: result.metrics.totalDurationMs,
      stages: result.metrics.stages.map(s => ({
        name: s.name,
        tokensIn: s.tokensIn,
        tokensOut: s.tokensOut,
        durationMs: s.durationMs,
      })),
    },
  };
};

// Tag used to mark facts derived from the seeded prior conversation.
// Nodes that declare `memory_query: { tags: [PRIOR_KNOWLEDGE_TAG] }` will
// see those facts in their prompt's Relevant Memory section.
const PRIOR_KNOWLEDGE_TAG = 'llm-knowledge';

/**
 * Memory retriever: fetches relevant facts from the memory hierarchy
 * for injection into agent prompts. Routes on entity IDs, tags, or a
 * mix — whichever the node's `memory_query` declares.
 */
const memoryRetriever: MemoryRetriever = async (query, options) => {
  const result = await retrieveMemory(memoryStore, memoryIndex, {
    entityIds: query.entityIds,
    tags: query.tags ?? [],
    limit: options?.maxFacts ?? 20,
    minSimilarity: 0.3,
    maxHops: 2,
    includeInvalidated: false,
  });

  return {
    facts: result.facts.map(f => ({ content: f.content, validFrom: f.valid_from })),
    entities: result.entities.map(e => ({ name: e.name, type: e.entity_type })),
    themes: result.themes.map(t => ({ label: t.label })),
  };
};

// ─── 4. Register agents ─────────────────────────────────────────────────

const registry = new InMemoryAgentRegistry();

const RESEARCHER_ID = registry.register({
  name: 'Research Agent',
  description: 'Gathers background information on a topic',
  model: 'claude-sonnet-4-6',
  provider: 'anthropic',
  systemPrompt: [
    'You are a research specialist.',
    'Given a goal, produce concise, factual research notes.',
    'Focus on key facts, statistics, and notable perspectives.',
    'Write your findings as bullet points.',
  ].join(' '),
  temperature: 0.5,
  maxSteps: 3,
  tools: [],
  permissions: {
    readKeys: ['goal', 'constraints'],
    writeKeys: ['research_notes'],
  },
});

const WRITER_ID = registry.register({
  name: 'Writer Agent',
  description: 'Produces a polished draft from research notes and memory',
  model: 'claude-sonnet-4-6',
  provider: 'anthropic',
  systemPrompt: [
    'You are a professional writer.',
    'Using the provided research notes and any relevant memory context, produce a clear and engaging summary.',
    'Keep it under 300 words. Use plain language.',
  ].join(' '),
  temperature: 0.7,
  maxSteps: 3,
  tools: [],
  permissions: {
    readKeys: ['goal', 'research_notes'],
    writeKeys: ['draft'],
  },
});

configureAgentFactory(registry);

const providers = createProviderRegistry();
configureProviderRegistry(providers);

// ─── 5. Define the graph ────────────────────────────────────────────────

const graph = createGraph({
  name: 'Research & Write with Memory',
  description: 'Two-node workflow with persistent memory and context compression',

  nodes: [
    {
      id: 'research',
      type: 'agent',
      agentId: RESEARCHER_ID,
      readKeys: ['goal', 'constraints'],
      writeKeys: ['research_notes'],
      // Pulls facts derived from the seeded prior conversation into the
      // researcher's prompt under a "## Relevant Memory" section.
      memoryQuery: { tags: [PRIOR_KNOWLEDGE_TAG], maxFacts: 10 },
      failurePolicy: { maxRetries: 2, backoffStrategy: 'exponential', initialBackoffMs: 1000, maxBackoffMs: 60000 },
      requiresCompensation: false,
    },
    {
      id: 'write',
      type: 'agent',
      agentId: WRITER_ID,
      readKeys: ['goal', 'research_notes'],
      writeKeys: ['draft'],
      memoryQuery: { tags: [PRIOR_KNOWLEDGE_TAG], maxFacts: 10 },
      failurePolicy: { maxRetries: 2, backoffStrategy: 'exponential', initialBackoffMs: 1000, maxBackoffMs: 60000 },
      requiresCompensation: false,
    },
  ],

  edges: [
    { source: 'research', target: 'write' },
  ],

  startNode: 'research',
  endNodes: ['write'],
});

// ─── 6. Create initial state ────────────────────────────────────────────

const initialState = createWorkflowState({
  workflowId: graph.id,
  goal: 'Explain how large language models work, including transformers, attention mechanisms, and training data.',
  constraints: ['Keep the final draft under 300 words', 'Use plain language suitable for a general audience'],
  maxExecutionTimeMs: 120_000,
});

// ─── 7. Seed the memory system with prior knowledge ─────────────────────
// Simulates a previous conversation that the memory system remembers.

async function seedMemory(): Promise<void> {
  const now = new Date();
  const priorMessages: Message[] = [
    {
      id: crypto.randomUUID(),
      role: 'user',
      content: 'What are transformers in the context of AI and machine learning?',
      timestamp: new Date(now.getTime() - 3600_000),
      metadata: {},
    },
    {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: 'Transformers are a neural network architecture introduced in the 2017 paper "Attention Is All You Need" by Vaswani et al. They use self-attention mechanisms to process input sequences in parallel, unlike RNNs which process sequentially. This makes them much faster to train on modern GPUs. The key innovation is the attention mechanism that lets each token attend to every other token, capturing long-range dependencies effectively.',
      timestamp: new Date(now.getTime() - 3540_000),
      metadata: {},
    },
    {
      id: crypto.randomUUID(),
      role: 'user',
      content: 'How are large language models trained?',
      timestamp: new Date(now.getTime() - 3000_000),
      metadata: {},
    },
    {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: 'Large language models are trained in two phases. First, pre-training on massive text corpora (books, web pages, code) using next-token prediction. The model learns grammar, facts, and reasoning patterns from this data. Second, fine-tuning with human feedback (RLHF) to align the model with human preferences. Training requires thousands of GPUs and costs millions of dollars. GPT-4 was reportedly trained on over 1 trillion tokens.',
      timestamp: new Date(now.getTime() - 2940_000),
      metadata: {},
    },
  ];

  await ingestMessages(priorMessages);
  logger.info(`Seeded memory with ${priorMessages.length} messages from a prior conversation`);

  // Show what was extracted
  const facts = await memoryStore.findFacts();
  const entities = await memoryStore.findEntities();
  const themes = await memoryStore.listThemes();
  logger.info(`  Facts extracted: ${facts.length}`);
  logger.info(`  Entities detected: ${entities.length}`);
  logger.info(`  Themes clustered: ${themes.length}`);
}

// ─── 8. Run ─────────────────────────────────────────────────────────────

async function main() {
  logger.info('═══ Context Engine + Memory Example ═══\n');

  // Step 1: Seed memory from a simulated prior conversation
  logger.info('Step 1: Seeding memory from prior conversation...');
  await seedMemory();

  // Step 2: Run the workflow with memory + compression
  logger.info('\nStep 2: Running research-and-write workflow...');
  logger.info('  contextCompressor: incremental pipeline (format + dedup + allocator)');
  logger.info('  memoryRetriever: hierarchical top-down retrieval\n');

  const persistence = new InMemoryPersistenceProvider();

  const runner = new GraphRunner(graph, initialState, {
    persistStateFn: async (state) => {
      await persistence.saveWorkflowState(state);
      await persistence.saveWorkflowRun(state);
    },
    contextCompressor,
    memoryRetriever,
  });

  // Observe compression and memory events
  runner.on('node:start', ({ node_id, type }) => {
    logger.info(`  Node started: ${node_id} (${type})`);
  });

  runner.on('node:complete', ({ node_id, duration_ms }) => {
    logger.info(`  Node complete: ${node_id} (${duration_ms}ms)`);
  });

  runner.on('context:compressed', (event) => {
    logger.info(`  Context compressed: ${event.reduction_percent.toFixed(1)}% reduction (${event.total_duration_ms.toFixed(0)}ms)`);
  });

  try {
    const finalState = await runner.run();

    if (finalState.status === 'completed') {
      // Step 3: Ingest the workflow output into memory for future runs
      logger.info('\nStep 3: Ingesting workflow output into memory...');
      const outputMessages: Message[] = [];
      if (finalState.memory.research_notes) {
        outputMessages.push({
          id: crypto.randomUUID(),
          role: 'assistant',
          content: String(finalState.memory.research_notes),
          timestamp: new Date(),
          metadata: {},
        });
      }
      if (finalState.memory.draft) {
        outputMessages.push({
          id: crypto.randomUUID(),
          role: 'assistant',
          content: String(finalState.memory.draft),
          timestamp: new Date(),
          metadata: {},
        });
      }
      if (outputMessages.length > 0) {
        await ingestMessages(outputMessages);
      }

      // Step 4: Run consolidation to clean up duplicates
      logger.info('\nStep 4: Running memory consolidation...');
      const consolidator = new MemoryConsolidator(memoryStore, memoryIndex, {
        maxFacts: 50,
        dedupThreshold: 0.9,
        decayHalfLifeDays: 30,
        batchSize: 1000,
        logger: { warn: (msg) => logger.warn(msg) },
      });
      const report = await consolidator.consolidate();
      logger.info(`  Deduped: ${report.factsDeduped}, Decayed: ${report.factsDecayed}, Themes cleaned: ${report.themesCleanedUp}`);

      // Step 5: Detect and resolve conflicts
      logger.info('\nStep 5: Running conflict detection...');
      const detector = new ConflictDetector(memoryStore, memoryIndex, {
        autoResolveSupersession: true,
        supersessionDayThreshold: 1,
      });
      const conflicts = await detector.detectConflicts();
      logger.info(`  Conflicts found: ${conflicts.length}`);

      // Print results
      const finalFacts = await memoryStore.findFacts({ includeInvalidated: false });
      const finalEntities = await memoryStore.findEntities();
      const finalThemes = await memoryStore.listThemes();

      console.log('\n═══ Research Notes ═══');
      console.log(finalState.memory.research_notes ?? '(none)');
      console.log('\n═══ Final Draft ═══');
      console.log(finalState.memory.draft ?? '(none)');
      console.log('\n═══ Memory System State ═══');
      console.log(`  Active facts:    ${finalFacts.length}`);
      console.log(`  Entities:        ${finalEntities.length}`);
      console.log(`  Themes:          ${finalThemes.length}`);
      console.log('\n═══ Workflow Stats ═══');
      console.log(`  Tokens used:     ${finalState.total_tokens_used}`);
      console.log(`  Cost (USD):      $${finalState.total_cost_usd.toFixed(4)}`);
    } else {
      console.error(`Workflow ended with status: ${finalState.status}`);
      if (finalState.last_error) {
        console.error(`Error: ${finalState.last_error}`);
      }
      process.exit(1);
    }
  } catch (err) {
    console.error('Fatal error:', err);
    process.exit(1);
  }
}

main();
