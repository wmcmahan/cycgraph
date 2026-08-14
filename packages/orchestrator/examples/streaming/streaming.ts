/**
 * Streaming — Runnable Example (authoring facade)
 *
 * A 2-node linear workflow consumed via `stream()` instead of `run()`.
 * Demonstrates real-time event handling including token-by-token output,
 * typed event discrimination, and the `isTerminalEvent()` type guard.
 *
 * Authored with the facade vocabulary (`agent` / `node` / `graph`), then run
 * through an explicit GraphRunner because the example consumes
 * `runner.stream()`, which the one-call `run()` helper does not expose.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/streaming/streaming.ts
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
  isTerminalEvent,
} from '@cycgraph/orchestrator';
import { MODEL, PROVIDER, exampleProviders, missingCredentials } from '../_model.js';

// ─── 0. Fail fast if no API key ──────────────────────────────────────────

const missing = missingCredentials();
if (missing) {
  console.error(`Error: ${missing}`);
  process.exit(1);
}

// ─── 1. Define agents ────────────────────────────────────────────────────
// An agent() value is a capability: model, instructions, sampling. No id
// (graph() mints one) and no permissions (the node's grants are authoritative).

const researcher = agent({
  name: 'Research Agent',
  description: 'Gathers background information on a topic',
  model: MODEL,
  provider: PROVIDER,
  instructions: [
    'You are a research specialist.',
    'Given a goal, produce concise, factual research notes as bullet points.',
  ].join(' '),
  temperature: 0.5,
  maxSteps: 3,
});

const writer = agent({
  name: 'Writer Agent',
  description: 'Produces a polished draft from research notes',
  model: MODEL,
  provider: PROVIDER,
  instructions: [
    'You are a professional writer.',
    'Using the provided research notes, produce a clear and engaging summary under 200 words.',
  ].join(' '),
  temperature: 0.7,
  maxSteps: 3,
});

// ─── 2. Place them in a graph ────────────────────────────────────────────

const research = node({
  id: 'research',
  agent: researcher,
  reads: ['goal', 'constraints'],
  writes: 'research_notes',
  failurePolicy: { maxRetries: 2 },
});

const write = node({
  id: 'write',
  agent: writer,
  reads: ['goal', 'research_notes'],
  writes: 'draft',
  failurePolicy: { maxRetries: 2 },
});

// Linear: research → write. Start/end are inferred (research has no inbound
// edge, write has no outbound edge).
const workflow = graph({
  name: 'Streaming Research & Write',
  description: 'Two-node linear workflow with streaming output',
  nodes: [research, write],
  edges: [{ from: research, to: write }],
});

// ─── 3. Set up registry and state ────────────────────────────────────────
// The graph carries its agent() configs; register them into a run-scoped
// registry for the explicit GraphRunner path.

const registry = new InMemoryAgentRegistry();
for (const config of agentsForGraph(workflow)) registry.register(config);

const initialState = state({
  workflowId: workflow.id,
  goal: 'Explain how large language models work, covering transformers and attention.',
  constraints: ['Keep under 200 words', 'Use plain language'],
  maxExecutionTimeMs: 120_000,
});

// ─── 4. Stream execution ─────────────────────────────────────────────────

async function main() {
  const persistence = new InMemoryPersistenceProvider();

  const runner = new GraphRunner(workflow, initialState, {
  providers: exampleProviders(),
    registry,
    persistState: async (s) => {
      await persistence.saveWorkflowState(s);
    },
  });

  console.log('Starting streaming workflow...\n');

  for await (const event of runner.stream()) {
    switch (event.type) {
      case 'workflow:start':
        console.log(`[workflow:start] run_id=${event.run_id}\n`);
        break;

      case 'node:start':
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
