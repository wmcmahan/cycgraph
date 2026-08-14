/**
 * Supervisor Routing — Runnable Example (authoring facade)
 *
 * A 4-node cyclic hub-and-spoke workflow: a Supervisor agent dynamically
 * routes work between Research, Write, and Edit specialist agents.
 *
 * Demonstrates: supervisor pattern, LLM-powered dynamic routing,
 * cyclic graphs, hub-and-spoke topology, and the __done__ sentinel.
 *
 * Authored with the facade vocabulary (`agent` / `node` / `graph`), then run
 * through an explicit GraphRunner because the example inspects the final
 * WorkflowState (routing history, visited nodes, cost) and attaches event
 * listeners, which the one-call `run()` helper does not expose.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/supervisor-routing/supervisor-routing.ts
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
  supervisor,
} from '@cycgraph/orchestrator';
import { MODEL, PROVIDER, exampleProviders, missingCredentials } from '../_model.js';

// ─── 0. Fail fast if the run can't reach a model ─────────────────────────

const missing = missingCredentials();
if (missing) {
  console.error(`Error: ${missing}`);
  process.exit(1);
}

const logger = createLogger('example');

// ─── 1. Define agents ────────────────────────────────────────────────────
// An agent() value is a capability: model, instructions, sampling. No id
// (graph() mints one) and no permissions (the node's grants are authoritative).

const supervisorAgent = agent({
  name: 'Supervisor Agent',
  description: 'Routes tasks between specialist agents to produce a polished article',
  model: MODEL,
  provider: PROVIDER,
  instructions: [
    'You are a project supervisor coordinating a team of specialists to produce a high-quality article.',
    'You have three team members: "research" (gathers facts), "write" (produces drafts), and "edit" (polishes prose).',
    'Review the current state and decide which specialist should work next.',
    'Typical flow: research → write → edit, but you may loop back if quality is insufficient.',
    'When the final_draft is polished and ready, route to "__done__" to complete the workflow.',
  ].join(' '),
  temperature: 0.3,
  maxSteps: 3,
});

const researcherAgent = agent({
  name: 'Research Agent',
  description: 'Gathers background information on a topic',
  model: MODEL,
  provider: PROVIDER,
  instructions: [
    'You are a research specialist.',
    'Given a goal, produce concise, factual research notes.',
    'Focus on key facts, statistics, and notable perspectives.',
    'Write your findings as bullet points.',
  ].join(' '),
  temperature: 0.5,
  maxSteps: 3,
});

const writerAgent = agent({
  name: 'Writer Agent',
  description: 'Produces a draft article from research notes',
  model: MODEL,
  provider: PROVIDER,
  instructions: [
    'You are a professional writer.',
    'Using the provided research notes, produce a clear and engaging article draft.',
    'Keep it under 500 words. Use plain language.',
  ].join(' '),
  temperature: 0.7,
  maxSteps: 3,
});

const editorAgent = agent({
  name: 'Editor Agent',
  description: 'Polishes a draft into a final article',
  model: MODEL,
  provider: PROVIDER,
  instructions: [
    'You are a meticulous editor.',
    'Review the draft for clarity, grammar, flow, and factual accuracy.',
    'Produce a polished final version.',
  ].join(' '),
  temperature: 0.4,
  maxSteps: 3,
});

// ─── 2. Place them in a graph ────────────────────────────────────────────
// Cyclic hub-and-spoke: supervisor ⇄ research, supervisor ⇄ write, supervisor ⇄ edit.
// The supervisor routes dynamically; termination is via the __done__ sentinel.

const research = node({
  id: 'research',
  agent: researcherAgent,
  reads: ['goal', 'constraints'],
  writes: 'research_notes',
  failurePolicy: { maxRetries: 2 },
});

const write = node({
  id: 'write',
  agent: writerAgent,
  reads: ['goal', 'research_notes'],
  writes: 'draft',
  failurePolicy: { maxRetries: 2 },
});

const edit = node({
  id: 'edit',
  agent: editorAgent,
  reads: ['goal', 'draft'],
  writes: 'final_draft',
  failurePolicy: { maxRetries: 2 },
});

// No reads declared: a supervisor derives its reads from the managed nodes'
// writes, and its routing/completion permissions are implied by the node type.
// Goal and constraints are always visible.
const lead = supervisor(supervisorAgent, {
  id: 'supervisor',
  manages: [research, write, edit],
  maxIterations: 10,
  failurePolicy: { maxRetries: 2 },
});

// Every node in a cycle has inbound and outbound edges, so start/end cannot
// be inferred: pass them explicitly.
const workflow = graph({
  name: 'Supervisor Routing',
  description: 'Cyclic hub-and-spoke workflow with LLM-powered dynamic routing',
  nodes: [lead, research, write, edit],
  edges: [
    // Supervisor → specialists (outbound)
    { from: lead, to: research },
    { from: lead, to: write },
    { from: lead, to: edit },
    // Specialists → supervisor (return)
    { from: research, to: lead },
    { from: write, to: lead },
    { from: edit, to: lead },
  ],
  startNode: lead,
  endNodes: [], // Termination via __done__ sentinel
});

// ─── 3. Set up registry, state, and runner ───────────────────────────────
// The graph carries its agent() configs; register them into a run-scoped
// registry for the explicit GraphRunner path.

const registry = new InMemoryAgentRegistry();
for (const config of agentsForGraph(workflow)) registry.register(config);

const initialState = state({
  workflowId: workflow.id,
  goal: 'Write a concise article about how renewable energy is transforming the global power grid, covering solar, wind, and battery storage.',
  constraints: ['Keep the final article under 500 words', 'Use plain language suitable for a general audience'],
  maxExecutionTimeMs: 300_000,
});

const persistence = new InMemoryPersistenceProvider();

const runner = new GraphRunner(workflow, initialState, {
  registry,
  providers: exampleProviders(),
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
