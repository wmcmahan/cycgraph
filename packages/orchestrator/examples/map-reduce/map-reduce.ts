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
  system_prompt: [
    'You are a topic decomposition specialist.',
    'Given a research goal, break it down into 4-5 focused sub-topics that together cover the full scope.',
    'Each sub-topic should be specific enough for a single researcher to investigate independently.',
    'Output a JSON array of sub-topic strings.',
    'Example: ["Sub-topic 1", "Sub-topic 2", "Sub-topic 3", "Sub-topic 4"]',
    'Output ONLY the JSON array, no other text.',
  ].join(' '),
  temperature: 0.5,
  max_steps: 3,
  tools: [],
  permissions: {
    read_keys: ['goal', 'constraints'],
    write_keys: ['topics'],
  },
});

const RESEARCHER_ID = registry.register({
  name: 'Researcher Agent',
  description: 'Investigates a specific sub-topic and produces research notes',
  model: 'claude-sonnet-4-6',
  provider: 'anthropic',
  system_prompt: [
    'You are a research specialist focused on a single sub-topic.',
    'Your assigned sub-topic is provided in _map_item. The broader goal is in the goal field.',
    'Produce concise, factual research notes (3-5 bullet points) about your specific sub-topic.',
    'Focus on key facts, data, and notable insights.',
  ].join(' '),
  temperature: 0.5,
  max_steps: 3,
  tools: [],
  permissions: {
    read_keys: ['_map_item', '_map_index', '_map_total', 'goal'],
    write_keys: ['research'],
  },
});

const SYNTHESIZER_ID = registry.register({
  name: 'Synthesizer Agent',
  description: 'Merges parallel research results into a unified summary',
  model: 'claude-sonnet-4-6',
  provider: 'anthropic',
  system_prompt: [
    'You are a synthesis specialist.',
    'You receive parallel research results in mapper_results (an array of objects with "updates" containing research notes).',
    'Combine all research into a single, coherent summary that covers every sub-topic.',
    'Keep it under 500 words. Use clear headings for each area.',
  ].join(' '),
  temperature: 0.4,
  max_steps: 3,
  tools: [],
  permissions: {
    read_keys: ['goal', 'mapper_results', 'mapper_count'],
    write_keys: ['summary'],
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
      agent_id: SPLITTER_ID,
      read_keys: ['goal', 'constraints'],
      write_keys: ['topics'],
      failure_policy: { max_retries: 2, backoff_strategy: 'exponential', initial_backoff_ms: 1000, max_backoff_ms: 60000 },
      requires_compensation: false,
    },
    {
      id: 'mapper',
      type: 'map',
      map_reduce_config: {
        worker_node_id: 'researcher',
        items_path: '$.memory.topics',
        max_concurrency: 5,
        error_strategy: 'best_effort',
      },
      read_keys: ['*'],
      write_keys: ['mapper_results', 'mapper_errors', 'mapper_count', 'mapper_error_count'],
      failure_policy: { max_retries: 1, backoff_strategy: 'exponential', initial_backoff_ms: 1000, max_backoff_ms: 60000 },
      requires_compensation: false,
    },
    {
      id: 'researcher',
      type: 'agent',
      agent_id: RESEARCHER_ID,
      read_keys: ['_map_item', '_map_index', '_map_total', 'goal'],
      write_keys: ['research'],
      failure_policy: { max_retries: 2, backoff_strategy: 'exponential', initial_backoff_ms: 1000, max_backoff_ms: 60000 },
      requires_compensation: false,
    },
    {
      id: 'synthesizer',
      type: 'synthesizer',
      agent_id: SYNTHESIZER_ID,
      read_keys: ['goal', 'mapper_results', 'mapper_count'],
      write_keys: ['summary'],
      failure_policy: { max_retries: 2, backoff_strategy: 'exponential', initial_backoff_ms: 1000, max_backoff_ms: 60000 },
      requires_compensation: false,
    },
  ],

  edges: [
    { source: 'splitter', target: 'mapper' },
    { source: 'mapper', target: 'synthesizer' },
  ],

  start_node: 'splitter',
  end_nodes: ['synthesizer'],
});

// ─── 3. Create initial state ─────────────────────────────────────────────

const initialState = createWorkflowState({
  workflow_id: graph.id,
  goal: 'Research the impacts of climate change across different sectors: agriculture, public health, infrastructure, biodiversity, and economic systems.',
  constraints: ['Each sub-topic research should be 3-5 bullet points', 'Final summary under 500 words'],
  max_execution_time_ms: 180_000,
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
