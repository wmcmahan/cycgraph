/**
 * Eval Loop — Runnable Example
 *
 * A 3-node cyclic workflow: a Writer drafts content, an Evaluator scores it,
 * and either loops back for revision (score < 0.8) or forwards to a Publisher
 * (score >= 0.8).
 *
 * Demonstrates: conditional edges, cyclic graphs, iterative refinement,
 * agent-as-config, in-memory persistence, and event listeners.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/eval-loop/eval-loop.ts
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
  console.error('Usage: ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/eval-loop/eval-loop.ts');
  process.exit(1);
}

const logger = createLogger('example');

// ─── 1. Register agents ──────────────────────────────────────────────────
// register() returns the auto-generated UUID for each agent.

const registry = new InMemoryAgentRegistry();

const WRITER_ID = registry.register({
  name: 'Writer Agent',
  description: 'Writes or refines a draft based on feedback',
  model: 'claude-sonnet-4-6',
  provider: 'anthropic',
  systemPrompt: [
    'You are a skilled writer.',
    'Your task: write a concise, engaging explanation of the given topic for a general audience.',
    'If memory.feedback and memory.suggestions are present, you are revising a previous draft — use that feedback to improve.',
    'If no feedback exists, write from scratch.',
    'Keep the draft under 250 words. Be clear and precise.',
  ].join(' '),
  temperature: 0.7,
  maxSteps: 3,
  tools: [],
  permissions: {
    readKeys: ['goal', 'constraints', 'feedback', 'suggestions', 'draft'],
    writeKeys: ['draft'],
  },
});

const EVALUATOR_ID = registry.register({
  name: 'Evaluator Agent',
  description: 'Scores a draft on quality and provides feedback',
  model: 'claude-sonnet-4-6',
  provider: 'anthropic',
  systemPrompt: [
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
  tools: [],
  permissions: {
    readKeys: ['goal', 'constraints', 'draft'],
    writeKeys: ['score', 'feedback', 'suggestions'],
  },
});

const PUBLISHER_ID = registry.register({
  name: 'Publisher Agent',
  description: 'Produces the final polished version',
  model: 'claude-sonnet-4-6',
  provider: 'anthropic',
  systemPrompt: [
    'You are a publishing editor.',
    'Take the approved draft and produce a final, polished version.',
    'Fix any remaining grammar, style, or clarity issues.',
    'Keep the spirit and structure of the original draft intact.',
  ].join(' '),
  temperature: 0.5,
  maxSteps: 3,
  tools: [],
  permissions: {
    readKeys: ['goal', 'draft'],
    writeKeys: ['final_output'],
  },
});
configureAgentFactory(registry);

// Configure LLM providers — built-in OpenAI + Anthropic are pre-registered.
// Add custom providers here (e.g., Groq, Ollama) via providers.register().
const providers = createProviderRegistry();
configureProviderRegistry(providers);

// ─── 2. Define the graph ─────────────────────────────────────────────────
// Cyclic graph with conditional edges:
//   writer → evaluator ──[score >= 0.8]──→ publisher (done)
//                │
//                └──[score < 0.8]──→ writer (loop back)

const graph = createGraph({
  name: 'Eval Loop',
  description: 'Cyclic write-evaluate-revise loop with conditional quality gate',

  nodes: [
    {
      id: 'writer',
      type: 'agent',
      agentId: WRITER_ID,
      readKeys: ['goal', 'constraints', 'feedback', 'suggestions', 'draft'],
      writeKeys: ['draft'],
      failurePolicy: { maxRetries: 2, backoffStrategy: 'exponential', initialBackoffMs: 1000, maxBackoffMs: 60000 },
      requiresCompensation: false,
    },
    {
      id: 'evaluator',
      type: 'agent',
      agentId: EVALUATOR_ID,
      readKeys: ['goal', 'constraints', 'draft'],
      writeKeys: ['score', 'feedback', 'suggestions'],
      failurePolicy: { maxRetries: 2, backoffStrategy: 'exponential', initialBackoffMs: 1000, maxBackoffMs: 60000 },
      requiresCompensation: false,
    },
    {
      id: 'publisher',
      type: 'agent',
      agentId: PUBLISHER_ID,
      readKeys: ['goal', 'draft'],
      writeKeys: ['final_output'],
      failurePolicy: { maxRetries: 2, backoffStrategy: 'exponential', initialBackoffMs: 1000, maxBackoffMs: 60000 },
      requiresCompensation: false,
    },
  ],

  edges: [
    // writer always goes to evaluator
    { source: 'writer', target: 'evaluator' },
    // loop back: evaluator → writer when score < 0.8
    { source: 'evaluator', target: 'writer', condition: { type: 'conditional', condition: 'number(memory.score) < 0.8' } },
    // quality gate: evaluator → publisher when score >= 0.8
    { source: 'evaluator', target: 'publisher', condition: { type: 'conditional', condition: 'number(memory.score) >= 0.8' } },
  ],

  startNode: 'writer',
  endNodes: ['publisher'],
});

// ─── 3. Create initial state ─────────────────────────────────────────────

const initialState = createWorkflowState({
  workflowId: graph.id,
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
