/**
 * Fan-Out Map-Reduce — Runnable Example
 *
 * A 4-node workflow demonstrating parallel fan-out with LLM-powered synthesis:
 *   1. Splitter agent decomposes a topic into sub-topics
 *   2. Map node fans out to parallel Researcher workers
 *   3. Synthesizer agent merges all research into a unified summary
 *
 * Demonstrates: map-reduce fan-out, parallel workers, synthesizer with agent_id,
 * JSONPath items resolution, state slicing with _map_item injection.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/map-reduce/map-reduce.ts
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

// ─── 0. Fail fast if no API key ──────────────────────────────────────────

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('Error: ANTHROPIC_API_KEY environment variable is required');
  console.error('Usage: ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/map-reduce/map-reduce.ts');
  process.exit(1);
}

const logger = createLogger('example');

// ─── 1. Register agents ──────────────────────────────────────────────────
// register() returns the auto-generated UUID for each agent.

const registry = new InMemoryAgentRegistry();

const SPLITTER_ID = registry.register({
  name: 'Splitter Agent',
  description: 'Decomposes a broad topic into focused sub-topics for parallel research',
  model: 'claude-sonnet-4-6',
  provider: 'anthropic',
  systemPrompt: [
    'You are a topic decomposition specialist.',
    'Given a research goal, break it down into 4-5 focused sub-topics that together cover the full scope.',
    'Each sub-topic should be specific enough for a single researcher to investigate independently.',
    'Output a JSON array of sub-topic strings.',
    'Example: ["Sub-topic 1", "Sub-topic 2", "Sub-topic 3", "Sub-topic 4"]',
    'Output ONLY the JSON array, no other text.',
  ].join(' '),
  temperature: 0.5,
  maxSteps: 3,
  tools: [],
  permissions: {
    readKeys: ['goal', 'constraints'],
    writeKeys: ['topics'],
  },
});

const RESEARCHER_ID = registry.register({
  name: 'Researcher Agent',
  description: 'Investigates a specific sub-topic and produces research notes',
  model: 'claude-sonnet-4-6',
  provider: 'anthropic',
  systemPrompt: [
    'You are a research specialist focused on a single sub-topic.',
    'Your assigned sub-topic is provided in _map_item. The broader goal is in the goal field.',
    'Produce concise, factual research notes (3-5 bullet points) about your specific sub-topic.',
    'Focus on key facts, data, and notable insights.',
  ].join(' '),
  temperature: 0.5,
  maxSteps: 3,
  tools: [],
  permissions: {
    readKeys: ['_map_item', '_map_index', '_map_total', 'goal'],
    writeKeys: ['research'],
  },
});

const SYNTHESIZER_ID = registry.register({
  name: 'Synthesizer Agent',
  description: 'Merges parallel research results into a unified summary',
  model: 'claude-sonnet-4-6',
  provider: 'anthropic',
  systemPrompt: [
    'You are a synthesis specialist.',
    'You receive parallel research results in mapper_results (an array of objects with "updates" containing research notes).',
    'Combine all research into a single, coherent summary that covers every sub-topic.',
    'Keep it under 500 words. Use clear headings for each area.',
  ].join(' '),
  temperature: 0.4,
  maxSteps: 3,
  tools: [],
  permissions: {
    readKeys: ['goal', 'mapper_results', 'mapper_count'],
    writeKeys: ['summary'],
  },
});
configureAgentFactory(registry);

// Configure LLM providers — built-in OpenAI + Anthropic are pre-registered.
// Add custom providers here (e.g., Groq, Ollama) via providers.register().
const providers = createProviderRegistry();
configureProviderRegistry(providers);

// ─── 2. Define the graph ─────────────────────────────────────────────────

const graph = createGraph({
  name: 'Fan-Out Map-Reduce',
  description: 'Parallel research with LLM-powered synthesis: split → map → synthesize',

  nodes: [
    {
      id: 'splitter',
      type: 'agent',
      agentId: SPLITTER_ID,
      readKeys: ['goal', 'constraints'],
      writeKeys: ['topics'],
      failurePolicy: { maxRetries: 2, backoffStrategy: 'exponential', initialBackoffMs: 1000, maxBackoffMs: 60000 },
      requiresCompensation: false,
    },
    {
      id: 'mapper',
      type: 'map',
      mapReduceConfig: {
        workerNodeId: 'researcher',
        itemsPath: '$.memory.topics',
        maxConcurrency: 5,
        errorStrategy: 'best_effort',
      },
      readKeys: ['*'],
      writeKeys: ['mapper_results', 'mapper_errors', 'mapper_count', 'mapper_error_count'],
      failurePolicy: { maxRetries: 1, backoffStrategy: 'exponential', initialBackoffMs: 1000, maxBackoffMs: 60000 },
      requiresCompensation: false,
    },
    {
      id: 'researcher',
      type: 'agent',
      agentId: RESEARCHER_ID,
      readKeys: ['_map_item', '_map_index', '_map_total', 'goal'],
      writeKeys: ['research'],
      failurePolicy: { maxRetries: 2, backoffStrategy: 'exponential', initialBackoffMs: 1000, maxBackoffMs: 60000 },
      requiresCompensation: false,
    },
    {
      id: 'synthesizer',
      type: 'synthesizer',
      agentId: SYNTHESIZER_ID,
      readKeys: ['goal', 'mapper_results', 'mapper_count'],
      writeKeys: ['summary'],
      failurePolicy: { maxRetries: 2, backoffStrategy: 'exponential', initialBackoffMs: 1000, maxBackoffMs: 60000 },
      requiresCompensation: false,
    },
  ],

  edges: [
    { source: 'splitter', target: 'mapper' },
    { source: 'mapper', target: 'synthesizer' },
  ],

  startNode: 'splitter',
  endNodes: ['synthesizer'],
});

// ─── 3. Create initial state ─────────────────────────────────────────────

const initialState = createWorkflowState({
  workflowId: graph.id,
  goal: 'Research the impacts of climate change across different sectors: agriculture, public health, infrastructure, biodiversity, and economic systems.',
  constraints: ['Each sub-topic research should be 3-5 bullet points', 'Final summary under 500 words'],
  maxExecutionTimeMs: 180_000,
});

// ─── 4. Set up persistence + runner ──────────────────────────────────────

const persistence = new InMemoryPersistenceProvider();

const runner = new GraphRunner(graph, initialState, {
  persistStateFn: async (state) => {
    await persistence.saveWorkflowState(state);
    await persistence.saveWorkflowRun(state);
  },
});

// Event listeners for observability
runner.on('workflow:start', ({ run_id }) => {
  logger.info(`Workflow started: ${run_id}`);
});

runner.on('node:start', ({ node_id, type }) => {
  logger.info(`  Node started: ${node_id} (${type})`);
});

runner.on('node:complete', ({ node_id, duration_ms }) => {
  logger.info(`  Node complete: ${node_id} (${duration_ms}ms)`);
});

runner.on('workflow:complete', ({ run_id, duration_ms }) => {
  logger.info(`Workflow complete: ${run_id} (${duration_ms}ms)`);
});

runner.on('workflow:failed', ({ run_id, error }) => {
  logger.error(`Workflow failed: ${run_id} — ${error}`);
});

// ─── 5. Run ──────────────────────────────────────────────────────────────

async function main() {
  logger.info('Starting fan-out map-reduce workflow...\n');

  try {
    const finalState = await runner.run();

    if (finalState.status === 'completed') {
      console.log('\n═══ Sub-Topics ═══');
      const topics = finalState.memory.topics;
      if (Array.isArray(topics)) {
        topics.forEach((t, i) => console.log(`  ${i + 1}. ${t}`));
      } else {
        console.log(topics ?? '(none)');
      }

      console.log('\n═══ Parallel Results ═══');
      const mapperCount = finalState.memory.mapper_count;
      const mapperErrorCount = finalState.memory.mapper_error_count;
      console.log(`  ${mapperCount ?? 0} researcher(s) completed successfully`);
      if (mapperErrorCount && Number(mapperErrorCount) > 0) {
        console.log(`  ${mapperErrorCount} researcher(s) failed`);
      }
      // Diagnostic: show what the splitter actually saved (string vs array)
      if (Array.isArray(topics)) {
        console.log(`  Fan-out: ${topics.length} sub-topics → ${mapperCount ?? 0} workers`);
      } else {
        console.log(`  Warning: "topics" was saved as ${typeof topics}, not an array — map fanned out to 1 worker`);
        console.log('  Tip: LLMs sometimes serialize arrays as strings. Re-run to retry.');
      }

      console.log('\n═══ Synthesized Summary ═══');
      console.log(finalState.memory.summary ?? '(none)');

      console.log('\n═══ Stats ═══');
      console.log(`  Tokens used: ${finalState.total_tokens_used}`);
      console.log(`  Cost (USD):  $${finalState.total_cost_usd.toFixed(4)}`);
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
