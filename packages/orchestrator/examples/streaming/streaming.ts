/**
 * Streaming — Runnable Example
 *
 * A 2-node linear workflow consumed via `stream()` instead of `run()`.
 * Demonstrates real-time event handling including token-by-token output,
 * typed event discrimination, and the `isTerminalEvent()` type guard.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/streaming/streaming.ts
 */

import {
  GraphRunner,
  InMemoryPersistenceProvider,
  InMemoryAgentRegistry,
  createProviderRegistry,
  configureAgentFactory,
  configureProviderRegistry,
  isTerminalEvent,
  createGraph,
  createWorkflowState,
} from '@cycgraph/orchestrator';

// ─── 0. Fail fast if no API key ──────────────────────────────────────────

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('Error: ANTHROPIC_API_KEY environment variable is required');
  console.error('Usage: ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/streaming/streaming.ts');
  process.exit(1);
}

// ─── 1. Register agents ──────────────────────────────────────────────────

const registry = new InMemoryAgentRegistry();

const RESEARCHER_ID = registry.register({
  name: 'Research Agent',
  description: 'Gathers background information on a topic',
  model: 'claude-sonnet-4-6',
  provider: 'anthropic',
  systemPrompt: [
    'You are a research specialist.',
    'Given a goal, produce concise, factual research notes as bullet points.',
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
  description: 'Produces a polished draft from research notes',
  model: 'claude-sonnet-4-6',
  provider: 'anthropic',
  systemPrompt: [
    'You are a professional writer.',
    'Using the provided research notes, produce a clear and engaging summary under 200 words.',
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

// Configure LLM providers — built-in OpenAI + Anthropic are pre-registered.
// Add custom providers here (e.g., Groq, Ollama) via providers.register().
const providers = createProviderRegistry();
configureProviderRegistry(providers);

// ─── 2. Define the graph ─────────────────────────────────────────────────

const graph = createGraph({
  name: 'Streaming Research & Write',
  description: 'Two-node linear workflow with streaming output',
  nodes: [
    {
      id: 'research',
      type: 'agent',
      agentId: RESEARCHER_ID,
      readKeys: ['goal', 'constraints'],
      writeKeys: ['research_notes'],
      failurePolicy: { maxRetries: 2, backoffStrategy: 'exponential', initialBackoffMs: 1000, maxBackoffMs: 60000 },
      requiresCompensation: false,
    },
    {
      id: 'write',
      type: 'agent',
      agentId: WRITER_ID,
      readKeys: ['goal', 'research_notes'],
      writeKeys: ['draft'],
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

// ─── 3. Create initial state ─────────────────────────────────────────────

const initialState = createWorkflowState({
  workflowId: graph.id,
  goal: 'Explain how large language models work, covering transformers and attention.',
  constraints: ['Keep under 200 words', 'Use plain language'],
  maxExecutionTimeMs: 120_000,
});

// ─── 4. Stream execution ─────────────────────────────────────────────────

async function main() {
  const persistence = new InMemoryPersistenceProvider();

  const runner = new GraphRunner(graph, initialState, {
    persistStateFn: async (state) => {
      await persistence.saveWorkflowState(state);
    },
  });

  console.log('Starting streaming workflow...\n');

  let currentNode = '';

  for await (const event of runner.stream()) {
    switch (event.type) {
      case 'workflow:start':
        console.log(`[workflow:start] run_id=${event.run_id}\n`);
        break;

      case 'node:start':
        currentNode = event.node_id;
        console.log(`\n[node:start] ${event.node_id} (${event.node_type})`);
        break;

      case 'agent:token_delta':
        // Real-time token streaming — write each token as it arrives
        process.stdout.write(event.token);
        break;

      case 'node:complete':
        console.log(`\n[node:complete] ${event.node_id} (${event.duration_ms}ms)`);
        break;

      case 'action:applied':
        console.log(`[action:applied] ${event.action_type} on ${event.node_id}`);
        break;

      case 'state:persisted':
        console.log(`[state:persisted] iteration=${event.iteration}`);
        break;

      case 'node:retry':
        console.log(`[node:retry] ${event.node_id} attempt=${event.attempt} backoff=${event.backoff_ms}ms`);
        break;

      case 'budget:threshold_reached':
        console.log(`[budget] ${event.threshold_pct}% of $${event.budget_usd} used`);
        break;
    }

    // Use the type guard to detect terminal events
    if (isTerminalEvent(event)) {
      console.log(`\n[${event.type}] Final status: ${event.state.status}`);

      if (event.type === 'workflow:complete') {
        console.log('\n═══ Research Notes ═══');
        console.log(event.state.memory.research_notes ?? '(none)');
        console.log('\n═══ Final Draft ═══');
        console.log(event.state.memory.draft ?? '(none)');
        console.log('\n═══ Stats ═══');
        console.log(`  Tokens used: ${event.state.total_tokens_used}`);
        console.log(`  Cost (USD):  $${event.state.total_cost_usd.toFixed(4)}`);
      } else if (event.type === 'workflow:failed') {
        console.error(`Error: ${event.error}`);
        process.exit(1);
      }
    }
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
