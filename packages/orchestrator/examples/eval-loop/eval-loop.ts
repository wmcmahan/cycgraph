/**
 * Eval Loop — Runnable Example (authoring facade)
 *
 * A 3-node cyclic workflow: a Writer drafts content, an Evaluator scores it,
 * and either loops back for revision (score < 0.8) or forwards to a Publisher
 * (score >= 0.8).
 *
 * Demonstrates: conditional edges, cyclic graphs, iterative refinement, and
 * the __done__-free termination via a quality gate.
 *
 * Authored with the facade vocabulary (`agent` / `node` / `graph`), then run
 * through an explicit GraphRunner because the example inspects the final
 * WorkflowState (iteration count, score, cost) and attaches event listeners,
 * which the one-call `run()` helper does not expose.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/eval-loop/eval-loop.ts
 */

import {
  agent,
  node,
  graph,
  state,
  agentsForGraph,
  GraphRunner,
  InMemoryAgentRegistry,
  InMemoryPersistenceProvider,
  createLogger,
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
// An agent() value is a capability: model, instructions, sampling. No id
// (graph() mints one) and no permissions (the node's grants are authoritative).

const writerAgent = agent({
  name: 'Writer Agent',
  description: 'Writes or refines a draft based on feedback',
  model: MODEL,
  provider: PROVIDER,
  instructions: [
    'You are a skilled writer.',
    'Your task: write a concise, engaging explanation of the given topic for a general audience.',
    'If memory.feedback and memory.suggestions are present, you are revising a previous draft — use that feedback to improve.',
    'If no feedback exists, write from scratch.',
    'Keep the draft under 250 words. Be clear and precise.',
  ].join(' '),
  temperature: 0.7,
  maxSteps: 3,
});

const evaluatorAgent = agent({
  name: 'Evaluator Agent',
  description: 'Scores a draft on quality and provides feedback',
  model: MODEL,
  provider: PROVIDER,
  instructions: [
    'You are a writing evaluator.',
    'Read the draft and score it on clarity, accuracy, engagement, and conciseness.',
    'You MUST call save_to_memory THREE times:',
    '1. key "score" — a single number between 0 and 1 (e.g. 0.72).',
    '2. key "feedback" — a brief paragraph explaining what works and what does not.',
    '3. key "suggestions" — a bullet list of specific improvements.',
    'Scoring guide: 0.0–0.4 = poor, 0.5–0.6 = needs work, 0.7–0.79 = good but improvable, 0.8–0.89 = strong, 0.9–1.0 = exceptional.',
    'A draft that is clear, accurate, well-structured, and meets the constraints should score 0.8 or above.',
    'Do not be needlessly harsh — if the draft genuinely meets the goal, reflect that in the score.',
  ].join(' '),
  temperature: 0.3,
  maxSteps: 5,
});

const publisherAgent = agent({
  name: 'Publisher Agent',
  description: 'Produces the final polished version',
  model: MODEL,
  provider: PROVIDER,
  instructions: [
    'You are a publishing editor.',
    'Take the approved draft and produce a final, polished version.',
    'Fix any remaining grammar, style, or clarity issues.',
    'Keep the spirit and structure of the original draft intact.',
  ].join(' '),
  temperature: 0.5,
  maxSteps: 3,
});

// ─── 2. Place them in a graph ────────────────────────────────────────────
// Cyclic graph with conditional edges:
//   writer → evaluator ──[score >= 0.8]──→ publisher (done)
//                │
//                └──[score < 0.8]──→ writer (loop back)

const writer = node({
  id: 'writer',
  agent: writerAgent,
  reads: ['goal', 'constraints', 'feedback', 'suggestions', 'draft'],
  writes: 'draft',
  failurePolicy: { maxRetries: 2 },
});

const evaluator = node({
  id: 'evaluator',
  agent: evaluatorAgent,
  reads: ['goal', 'constraints', 'draft'],
  writes: ['score', 'feedback', 'suggestions'],
  failurePolicy: { maxRetries: 2 },
});

const publisher = node({
  id: 'publisher',
  agent: publisherAgent,
  reads: ['goal', 'draft'],
  writes: 'final_output',
  failurePolicy: { maxRetries: 2 },
});

// Cyclic graph: the loop-back edge means start/end cannot be inferred, so
// pass them explicitly. Edge order matters — the runner takes the first
// matching edge, so the loop-back is listed before the exit.
const workflow = graph({
  name: 'Eval Loop',
  description: 'Cyclic write-evaluate-revise loop with conditional quality gate',
  nodes: [writer, evaluator, publisher],
  edges: [
    // writer always goes to evaluator
    { from: writer, to: evaluator },
    // loop back: evaluator → writer when score < 0.8
    { from: evaluator, to: writer, when: 'number(memory.score) < 0.8' },
    // quality gate: evaluator → publisher when score >= 0.8
    { from: evaluator, to: publisher, when: 'number(memory.score) >= 0.8' },
  ],
  startNode: writer,
  endNodes: [publisher],
});

// ─── 3. Set up registry, state, and runner ───────────────────────────────
// The graph carries its agent() configs; register them into a run-scoped
// registry for the explicit GraphRunner path.

const registry = new InMemoryAgentRegistry();
for (const config of agentsForGraph(workflow)) registry.register(config);

const initialState = state({
  workflowId: workflow.id,
  goal: 'Write a concise explanation of quantum computing for a general audience.',
  constraints: [
    'Under 250 words',
    'No jargon without explanation',
    'Cover qubits, superposition, and entanglement',
    'Suitable for someone with no physics background',
  ],
  maxIterations: 20,
  maxExecutionTimeMs: 300_000,
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
  logger.info('Starting eval-loop workflow...\n');

  try {
    const finalState = await runner.run();

    if (finalState.status === 'completed') {
      // Count iterations from the visited_nodes cycle
      const evalCount = finalState.visited_nodes.filter((n: string) => n === 'evaluator').length;

      console.log('\n═══ Results ═══');
      console.log(`  Iterations: ${evalCount} evaluation round(s)`);
      console.log(`  Final score: ${finalState.memory.score ?? '(unknown)'}`);
      console.log(`  Path: ${finalState.visited_nodes.join(' → ')}`);

      console.log('\n═══ Evaluator Feedback (last round) ═══');
      console.log(finalState.memory.feedback ?? '(none)');

      console.log('\n═══ Published Output ═══');
      console.log(finalState.memory.final_output ?? '(none)');

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
