/**
 * Supervisor Routing — Runnable Example
 *
 * A 4-node cyclic hub-and-spoke workflow: a Supervisor agent dynamically
 * routes work between Research, Write, and Edit specialist agents.
 *
 * Demonstrates: supervisor pattern, LLM-powered dynamic routing,
 * cyclic graphs, hub-and-spoke topology, and the __done__ sentinel.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/supervisor-routing/supervisor-routing.ts
 */

import {
  GraphRunner,
  InMemoryPersistenceProvider,
  InMemoryAgentRegistry,
  configureAgentFactory,
  ProviderRegistry,
  createProviderRegistry,
  configureProviderRegistry,
  createLogger,
  createGraph,
  createWorkflowState,
} from '@cycgraph/orchestrator';

// ─── 0. Fail fast if no API key ──────────────────────────────────────────

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('Error: ANTHROPIC_API_KEY environment variable is required');
  console.error('Usage: ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/supervisor-routing/supervisor-routing.ts');
  process.exit(1);
}

const logger = createLogger('example');

// ─── 1. Register agents ──────────────────────────────────────────────────
// register() returns the auto-generated UUID for each agent.

const registry = new InMemoryAgentRegistry();

const SUPERVISOR_ID = registry.register({
  name: 'Supervisor Agent',
  description: 'Routes tasks between specialist agents to produce a polished article',
  model: 'claude-sonnet-4-6',
  provider: 'anthropic',
  system_prompt: [
    'You are a project supervisor coordinating a team of specialists to produce a high-quality article.',
    'You have three team members: "research" (gathers facts), "write" (produces drafts), and "edit" (polishes prose).',
    'Review the current state and decide which specialist should work next.',
    'Typical flow: research → write → edit, but you may loop back if quality is insufficient.',
    'When the final_draft is polished and ready, route to "__done__" to complete the workflow.',
  ].join(' '),
  temperature: 0.3,
  max_steps: 3,
  tools: [],
  permissions: {
    read_keys: ['*'],
    write_keys: ['*'],
  },
});

const RESEARCHER_ID = registry.register({
  name: 'Research Agent',
  description: 'Gathers background information on a topic',
  model: 'claude-sonnet-4-6',
  provider: 'anthropic',
  system_prompt: [
    'You are a research specialist.',
    'Given a goal, produce concise, factual research notes.',
    'Focus on key facts, statistics, and notable perspectives.',
    'Write your findings as bullet points.',
  ].join(' '),
  temperature: 0.5,
  max_steps: 3,
  tools: [],
  permissions: {
    read_keys: ['goal', 'constraints'],
    write_keys: ['research_notes'],
  },
});

const WRITER_ID = registry.register({
  name: 'Writer Agent',
  description: 'Produces a draft article from research notes',
  model: 'claude-sonnet-4-6',
  provider: 'anthropic',
  system_prompt: [
    'You are a professional writer.',
    'Using the provided research notes, produce a clear and engaging article draft.',
    'Keep it under 500 words. Use plain language.',
  ].join(' '),
  temperature: 0.7,
  max_steps: 3,
  tools: [],
  permissions: {
    read_keys: ['goal', 'research_notes'],
    write_keys: ['draft'],
  },
});

const EDITOR_ID = registry.register({
  name: 'Editor Agent',
  description: 'Polishes a draft into a final article',
  model: 'claude-sonnet-4-6',
  provider: 'anthropic',
  system_prompt: [
    'You are a meticulous editor.',
    'Review the draft for clarity, grammar, flow, and factual accuracy.',
    'Produce a polished final version.',
  ].join(' '),
  temperature: 0.4,
  max_steps: 3,
  tools: [],
  permissions: {
    read_keys: ['goal', 'draft'],
    write_keys: ['final_draft'],
  },
});
configureAgentFactory(registry);

// Configure LLM providers — built-in OpenAI + Anthropic are pre-registered.
// Add custom providers here (e.g., Groq, Ollama) via providers.register().
const providers = createProviderRegistry();
configureProviderRegistry(providers);

// ─── 2. Define the graph ─────────────────────────────────────────────────
// Cyclic hub-and-spoke: supervisor ⇄ research, supervisor ⇄ write, supervisor ⇄ edit.
// The supervisor routes dynamically; termination is via the __done__ sentinel.

const graph = createGraph({
  name: 'Supervisor Routing',
  description: 'Cyclic hub-and-spoke workflow with LLM-powered dynamic routing',

  nodes: [
    {
      id: 'supervisor',
      type: 'supervisor',
      agent_id: SUPERVISOR_ID,
      read_keys: ['*'],
      write_keys: ['*'],
      supervisor_config: {
        managed_nodes: ['research', 'write', 'edit'],
        max_iterations: 10,
      },
      failure_policy: { max_retries: 2, backoff_strategy: 'exponential', initial_backoff_ms: 1000, max_backoff_ms: 60000 },
      requires_compensation: false,
    },
    {
      id: 'research',
      type: 'agent',
      agent_id: RESEARCHER_ID,
      read_keys: ['goal', 'constraints'],
      write_keys: ['research_notes'],
      failure_policy: { max_retries: 2, backoff_strategy: 'exponential', initial_backoff_ms: 1000, max_backoff_ms: 60000 },
      requires_compensation: false,
    },
    {
      id: 'write',
      type: 'agent',
      agent_id: WRITER_ID,
      read_keys: ['goal', 'research_notes'],
      write_keys: ['draft'],
      failure_policy: { max_retries: 2, backoff_strategy: 'exponential', initial_backoff_ms: 1000, max_backoff_ms: 60000 },
      requires_compensation: false,
    },
    {
      id: 'edit',
      type: 'agent',
      agent_id: EDITOR_ID,
      read_keys: ['goal', 'draft'],
      write_keys: ['final_draft'],
      failure_policy: { max_retries: 2, backoff_strategy: 'exponential', initial_backoff_ms: 1000, max_backoff_ms: 60000 },
      requires_compensation: false,
    },
  ],

  edges: [
    // Supervisor → specialists (outbound)
    { source: 'supervisor', target: 'research' },
    { source: 'supervisor', target: 'write' },
    { source: 'supervisor', target: 'edit' },
    // Specialists → supervisor (return)
    { source: 'research', target: 'supervisor' },
    { source: 'write', target: 'supervisor' },
    { source: 'edit', target: 'supervisor' },
  ],

  start_node: 'supervisor',
  end_nodes: [],  // Termination via __done__ sentinel
});

// ─── 3. Create initial state ─────────────────────────────────────────────

const initialState = createWorkflowState({
  workflow_id: graph.id,
  goal: 'Write a concise article about how renewable energy is transforming the global power grid, covering solar, wind, and battery storage.',
  constraints: ['Keep the final article under 500 words', 'Use plain language suitable for a general audience'],
  max_execution_time_ms: 300_000,
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
  logger.info('Starting supervisor-routing workflow...\n');

  try {
    const finalState = await runner.run();

    if (finalState.status === 'completed') {
      console.log('\n═══ Supervisor Routing History ═══');
      for (const entry of finalState.supervisor_history) {
        console.log(`  [iter ${entry.iteration}] → ${entry.delegated_to} (${entry.reasoning})`);
      }
      console.log('  → __done__ (workflow completed)');

      console.log('\n═══ Research Notes ═══');
      console.log(finalState.memory.research_notes ?? '(none)');
      console.log('\n═══ Draft ═══');
      console.log(finalState.memory.draft ?? '(none)');
      console.log('\n═══ Final Draft ═══');
      console.log(finalState.memory.final_draft ?? '(none)');
      console.log('\n═══ Stats ═══');
      console.log(`  Nodes visited:  ${finalState.visited_nodes.join(' → ')}`);
      console.log(`  Tokens used:    ${finalState.total_tokens_used}`);
      console.log(`  Cost (USD):     $${finalState.total_cost_usd.toFixed(4)}`);
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
