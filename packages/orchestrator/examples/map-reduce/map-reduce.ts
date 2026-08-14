/**
 * Fan-Out Map-Reduce — Runnable Example (authoring facade)
 *
 * A 4-node workflow demonstrating parallel fan-out with LLM-powered synthesis:
 *   1. Splitter agent decomposes a topic into sub-topics
 *   2. Map node fans out to parallel Researcher workers
 *   3. Synthesizer agent merges all research into a unified summary
 *
 * Demonstrates: map-reduce fan-out, parallel workers, synthesizer with an
 * agent, JSONPath items resolution, per-item Task Context injection.
 *
 * Authored with the facade vocabulary (`agent` / `node` / `graph`), then run
 * through an explicit GraphRunner because the example attaches event listeners
 * and inspects the final WorkflowState (status, token/cost totals), which the
 * one-call `run()` helper does not expose.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/map-reduce/map-reduce.ts
 */

import {
  agent,
  node,
  graph,
  state,
  agentsForGraph,
  GraphRunner,
  InMemoryPersistenceProvider,
  InMemoryAgentRegistry,
  createLogger,
  mapReduce,
  synthesizer,
} from '@cycgraph/orchestrator';
import { MODEL, PROVIDER, exampleProviders, missingCredentials } from '../_model.js';

// ─── 0. Fail fast if no API key ──────────────────────────────────────────

const missing = missingCredentials();
if (missing) {
  console.error(`Error: ${missing}`);
  process.exit(1);
}

const logger = createLogger('example');

// ─── 1. Define agents ────────────────────────────────────────────────────
// An agent() value is a capability: model, instructions, sampling. The node's
// reads/writes are the authoritative grants.

const splitterAgent = agent({
  name: 'Splitter Agent',
  description: 'Decomposes a broad topic into focused sub-topics for parallel research',
  model: MODEL,
  provider: PROVIDER,
  instructions: [
    'You are a topic decomposition specialist.',
    'Given a research goal, break it down into 4-5 focused sub-topics that together cover the full scope.',
    'Each sub-topic should be specific enough for a single researcher to investigate independently.',
    'Output a JSON array of sub-topic strings.',
    'Example: ["Sub-topic 1", "Sub-topic 2", "Sub-topic 3", "Sub-topic 4"]',
    'Output ONLY the JSON array, no other text.',
  ].join(' '),
  temperature: 0.5,
  maxSteps: 3,
});

const researcherAgent = agent({
  name: 'Researcher Agent',
  description: 'Investigates a specific sub-topic and produces research notes',
  model: MODEL,
  provider: PROVIDER,
  instructions: [
    'You are a research specialist focused on a single sub-topic.',
    'Your assigned sub-topic is provided as map_item in the Task Context section of your prompt. The broader goal is in the goal field.',
    'Produce concise, factual research notes (3-5 bullet points) about your specific sub-topic.',
    'Focus on key facts, data, and notable insights.',
  ].join(' '),
  temperature: 0.5,
  maxSteps: 3,
});

const synthesizerAgent = agent({
  name: 'Synthesizer Agent',
  description: 'Merges parallel research results into a unified summary',
  model: MODEL,
  provider: PROVIDER,
  instructions: [
    'You are a synthesis specialist.',
    'You receive parallel research results in mapper_results (an array of objects with "updates" containing research notes).',
    'Combine all research into a single, coherent summary that covers every sub-topic.',
    'Keep it under 500 words. Use clear headings for each area.',
  ].join(' '),
  temperature: 0.4,
  maxSteps: 3,
});

// ─── 2. Define the graph ─────────────────────────────────────────────────

const splitter = node({
  id: 'splitter',
  agent: splitterAgent,
  reads: ['goal', 'constraints'],
  writes: ['topics'],
  failurePolicy: { maxRetries: 2 },
});

// The four result keys are implied by the node type, so no writes here.
const mapper = mapReduce('researcher', {
  id: 'mapper',
  items: '$.memory.topics',
  concurrency: 5,
  onError: 'best_effort',
  reads: ['*'],
  failurePolicy: { maxRetries: 1 },
});

const researcher = node({
  id: 'researcher',
  agent: researcherAgent,
  // The map item arrives via the Task Context prompt section, not memory.
  reads: ['goal'],
  writes: ['research'],
  failurePolicy: { maxRetries: 2 },
});

// An agent-backed synthesizer authors its output, so `writes` is required:
// the implied `<id>_synthesis` key only applies to the agentless merge.
const combine = synthesizer({
  id: 'synthesizer',
  agent: synthesizerAgent,
  reads: ['goal', 'mapper_results', 'mapper_count'],
  writes: ['summary'],
  failurePolicy: { maxRetries: 2 },
});

// The worker node (researcher) has no edges — the map node drives it — so
// start/end cannot be inferred: pass them explicitly.
const workflow = graph({
  name: 'Fan-Out Map-Reduce',
  description: 'Parallel research with LLM-powered synthesis: split → map → synthesize',
  nodes: [splitter, mapper, researcher, combine],
  edges: [
    { from: splitter, to: mapper },
    { from: mapper, to: combine },
  ],
  startNode: splitter,
  endNodes: [combine],
});

// ─── 3. Set up registry, state, persistence, and runner ──────────────────

const registry = new InMemoryAgentRegistry();
for (const config of agentsForGraph(workflow)) registry.register(config);

const initialState = state({
  workflowId: workflow.id,
  goal: 'Research the impacts of climate change across different sectors: agriculture, public health, infrastructure, biodiversity, and economic systems.',
  constraints: ['Each sub-topic research should be 3-5 bullet points', 'Final summary under 500 words'],
  maxExecutionTimeMs: 180_000,
});

const persistence = new InMemoryPersistenceProvider();

const runner = new GraphRunner(workflow, initialState, {
  providers: exampleProviders(),
  registry,
  persistState: (s) => persistence.saveWorkflowSnapshot(s),
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

// ─── 4. Run ──────────────────────────────────────────────────────────────

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
