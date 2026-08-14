/**
 * Workflow Observer — one workflow triages another's event log, read-only.
 *
 * Run:  ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/workflow-observer/run.ts
 * See:  ./README.md for the two graphs and why this needs a capable model.
 */

import {
  agent,
  node,
  graph,
  agentsForGraph,
  GraphRunner,
  InMemoryPersistenceProvider,
  InMemoryAgentRegistry,
  InMemoryEventLogWriter,
  InMemoryWorkflowQueue,
  WorkflowWorker,
  state,
  createLogger,
  type WorkflowState,
  supervisor,
} from '@cycgraph/orchestrator';
import { MODEL, PROVIDER, exampleProviders, missingCredentials } from '../_model.js';

// ─── 0. Fail fast if no API key ─────────────────────────────────────────

const missing = missingCredentials();
if (missing) {
  console.error(`Error: ${missing}`);
  process.exit(1);
}

const logger = createLogger('example.observer');

// ─── 1. Shared infrastructure ───────────────────────────────────────────
// Both the target and observer workflows share these instances.
// The observer reads from the same event log and persistence the target writes to.

const persistence = new InMemoryPersistenceProvider();
const eventLog = new InMemoryEventLogWriter();
const queue = new InMemoryWorkflowQueue();

// ─── 2. Define target workflow agents ───────────────────────────────────
// A simple 3-agent supervisor workflow (no MCP — runs with just an API key).
// An agent() value is a capability: model, instructions, sampling. The node's
// reads/writes are the authoritative grant, so no permissions live here.

const targetSupervisorAgent = agent({
  name: 'Target Supervisor',
  description: 'Routes between researcher and writer',
  model: MODEL,
  provider: PROVIDER,
  instructions: [
    'You supervise a research-and-write workflow with two team members:',
    '  - "researcher": Produces research notes on the given topic.',
    '  - "writer": Writes a polished summary from the research notes.',
    '',
    'Workflow:',
    '1. Delegate to "researcher" first.',
    '2. After research notes exist in memory, delegate to "writer".',
    '3. After the summary is written, route to "__done__".',
  ].join('\n'),
  temperature: 0.3,
  maxSteps: 3,
});

const researcherAgent = agent({
  name: 'Researcher',
  description: 'Produces research notes on a topic using existing knowledge',
  model: MODEL,
  provider: PROVIDER,
  instructions: [
    'You are a research specialist. Produce detailed research notes on the topic in the goal.',
    'Cover key concepts, recent developments, and practical applications.',
  ].join('\n'),
  temperature: 0.5,
  maxSteps: 3,
});

const writerAgent = agent({
  name: 'Writer',
  description: 'Writes a polished summary from research notes',
  model: MODEL,
  provider: PROVIDER,
  instructions: [
    'You are a writer. Read the research_notes and produce a concise, polished summary.',
  ].join('\n'),
  temperature: 0.7,
  maxSteps: 3,
});

// ─── 3. Define observer workflow agents ─────────────────────────────────

const observerSupervisorAgent = agent({
  name: 'Observer Supervisor',
  description: 'Routes between triage specialist agents',
  model: MODEL,
  provider: PROVIDER,
  instructions: [
    'You are an observer supervisor triaging a completed workflow run.',
    'You have three specialists and a report writer:',
    '  - "token_analyst": Analyzes token usage patterns.',
    '  - "stall_detector": Detects routing loops or stalls.',
    '  - "error_classifier": Classifies any errors that occurred.',
    '  - "report_writer": Synthesizes all findings into a final report.',
    '',
    'Route to each specialist in order, then to report_writer, then "__done__".',
    'Do not skip any specialist — even if the data looks clean, each should confirm that.',
  ].join('\n'),
  temperature: 0.3,
  maxSteps: 3,
});

const tokenAnalystAgent = agent({
  name: 'Token Analyst',
  description: 'Analyzes token usage patterns for waste or anomalies',
  model: MODEL,
  provider: PROVIDER,
  instructions: [
    'You analyze token usage from a completed workflow run.',
    'You receive target_events (event log) and target_snapshot (state summary) in memory.',
    '',
    'Analyze:',
    '- Total tokens used vs number of meaningful outputs produced',
    '- Any agent that used >10K tokens without saving to memory (wasted work)',
    '- Token distribution across agents — is one agent disproportionately expensive?',
    '- Whether max_steps were exhausted on any agent (burned steps without output)',
    '',
    'Produce your analysis as a structured string.',
    'Include severity level (info/warning/critical) for each finding.',
  ].join('\n'),
  temperature: 0.3,
  maxSteps: 3,
});

const stallDetectorAgent = agent({
  name: 'Stall Detector',
  description: 'Detects routing loops, stalls, or anomalous patterns',
  model: MODEL,
  provider: PROVIDER,
  instructions: [
    'You detect stalls and routing anomalies in a completed workflow run.',
    'You receive target_events and target_snapshot in memory.',
    '',
    'Check for:',
    '- Supervisor routing to the same node 3+ times consecutively (routing loop)',
    '- iteration_count approaching max_iterations (near-stall)',
    '- Nodes visited multiple times without state progression',
    '- Unexpectedly long gaps between events (potential hangs)',
    '',
    'Produce your analysis as a structured string.',
    'Include severity level (info/warning/critical) for each finding.',
  ].join('\n'),
  temperature: 0.3,
  maxSteps: 3,
});

const errorClassifierAgent = agent({
  name: 'Error Classifier',
  description: 'Classifies errors from the workflow run',
  model: MODEL,
  provider: PROVIDER,
  instructions: [
    'You classify errors from a completed workflow run.',
    'You receive target_events and target_snapshot in memory.',
    '',
    'For each error found, classify as:',
    '- transient: API timeouts, rate limits, network issues (retryable)',
    '- config: Missing API keys, invalid model names, bad graph wiring (fix required)',
    '- data: Malformed inputs, missing required fields, type mismatches (data issue)',
    '',
    'Check target_snapshot.last_error and any internal_dispatched events with internal_type "_fail".',
    'If no errors occurred, explicitly state that the run was error-free.',
    '',
    'Produce your analysis as a structured string.',
    'Include severity level (info/warning/critical) for each finding.',
  ].join('\n'),
  temperature: 0.3,
  maxSteps: 3,
});

const reportWriterAgent = agent({
  name: 'Triage Report Writer',
  description: 'Synthesizes triage findings into a structured report',
  model: MODEL,
  provider: PROVIDER,
  instructions: [
    'You synthesize triage findings into a final structured report.',
    'You receive token_analysis, stall_analysis, and error_analysis in memory.',
    '',
    'Produce a triage report with:',
    '1. Overall health assessment: HEALTHY / DEGRADED / CRITICAL',
    '2. Summary of findings across all three categories',
    '3. Ordered list of issues by severity (critical first)',
    '4. Recommended actions for each issue',
    '',
    'Format as a clean markdown report.',
  ].join('\n'),
  temperature: 0.4,
  maxSteps: 3,
});

// ─── 4. Define the target workflow graph ────────────────────────────────
// Supervisor nodes omit reads/writes: derived reads (from the managed nodes'
// writes) and control-flow write permissions are implied by the node type.

const researcher = node({
  id: 'researcher',
  agent: researcherAgent,
  reads: ['goal'],
  writes: 'research_notes',
  failurePolicy: { maxRetries: 1, backoffStrategy: 'fixed', maxBackoffMs: 5000 },
});

const writer = node({
  id: 'writer',
  agent: writerAgent,
  reads: ['goal', 'research_notes'],
  writes: 'summary',
  failurePolicy: { maxRetries: 1, backoffStrategy: 'fixed', maxBackoffMs: 5000 },
});

const targetSupervisor = supervisor(targetSupervisorAgent, {
  id: 'supervisor',
  manages: [researcher, writer],
  maxIterations: 10,
  failurePolicy: { maxRetries: 1, maxBackoffMs: 30000 },
});

const targetGraph = graph({
  name: 'Target: Research & Write',
  description: 'Simple supervisor workflow for the observer to analyze',
  nodes: [targetSupervisor, researcher, writer],
  edges: [
    { from: targetSupervisor, to: researcher },
    { from: targetSupervisor, to: writer },
    { from: researcher, to: targetSupervisor },
    { from: writer, to: targetSupervisor },
  ],
  startNode: targetSupervisor,
  endNodes: [], // Termination via __done__ sentinel
});

// ─── 5. Define the observer workflow graph ──────────────────────────────

const tokenAnalyst = node({
  id: 'token_analyst',
  agent: tokenAnalystAgent,
  reads: ['target_events', 'target_snapshot'],
  writes: 'token_analysis',
  failurePolicy: { maxRetries: 1, backoffStrategy: 'fixed', maxBackoffMs: 5000 },
});

const stallDetector = node({
  id: 'stall_detector',
  agent: stallDetectorAgent,
  reads: ['target_events', 'target_snapshot'],
  writes: 'stall_analysis',
  failurePolicy: { maxRetries: 1, backoffStrategy: 'fixed', maxBackoffMs: 5000 },
});

const errorClassifier = node({
  id: 'error_classifier',
  agent: errorClassifierAgent,
  reads: ['target_events', 'target_snapshot'],
  writes: 'error_analysis',
  failurePolicy: { maxRetries: 1, backoffStrategy: 'fixed', maxBackoffMs: 5000 },
});

const reportWriter = node({
  id: 'report_writer',
  agent: reportWriterAgent,
  reads: ['token_analysis', 'stall_analysis', 'error_analysis', 'target_snapshot'],
  writes: 'triage_report',
  failurePolicy: { maxRetries: 1, backoffStrategy: 'fixed', maxBackoffMs: 5000 },
});

const observerSupervisor = supervisor(observerSupervisorAgent, {
  id: 'observer_supervisor',
  manages: [tokenAnalyst, stallDetector, errorClassifier, reportWriter],
  maxIterations: 8,
  failurePolicy: { maxRetries: 1, backoffStrategy: 'fixed', maxBackoffMs: 5000 },
});

const observerGraph = graph({
  name: 'Workflow Observer',
  description: 'Triage observer that analyzes a completed workflow run',
  nodes: [observerSupervisor, tokenAnalyst, stallDetector, errorClassifier, reportWriter],
  edges: [
    { from: observerSupervisor, to: tokenAnalyst },
    { from: observerSupervisor, to: stallDetector },
    { from: observerSupervisor, to: errorClassifier },
    { from: observerSupervisor, to: reportWriter },
    { from: tokenAnalyst, to: observerSupervisor },
    { from: stallDetector, to: observerSupervisor },
    { from: errorClassifier, to: observerSupervisor },
    { from: reportWriter, to: observerSupervisor },
  ],
  startNode: observerSupervisor,
  endNodes: [], // Termination via __done__ sentinel
});

// ─── 5b. Run-scoped agent registry ──────────────────────────────────────
// Both graphs carry their agent() configs. Register them into one shared
// registry that the target worker and observer runner both draw from.

const agentRegistry = new InMemoryAgentRegistry();
for (const config of agentsForGraph(targetGraph)) agentRegistry.register(config);
for (const config of agentsForGraph(observerGraph)) agentRegistry.register(config);

// ─── 6. Run the target workflow ─────────────────────────────────────────

async function runTargetWorkflow(): Promise<WorkflowState> {
  logger.info('Starting target workflow...');

  await persistence.saveGraph(targetGraph);

  const targetState = state({
    workflowId: targetGraph.id,
    goal: 'Explain the key differences between transformer and diffusion architectures in modern AI, covering attention mechanisms, training approaches, and practical applications.',
    maxIterations: 20,
    maxExecutionTimeMs: 120_000,
  });

  const worker = new WorkflowWorker({
    queue,
    persistence,
    eventLog,
    pollIntervalMs: 500,
    heartbeatIntervalMs: 30_000,
    reclaimIntervalMs: 15_000,
    shutdownGracePeriodMs: 10_000,
    runnerOptionsFactory: () => ({ registry: agentRegistry }),
  });

  worker.on('job:completed', ({ jobId }) => {
    logger.info(`Target job completed: ${jobId}`);
  });
  worker.on('job:failed', ({ jobId, error }) => {
    logger.error(`Target job failed: ${jobId} — ${error}`);
  });

  await worker.start();

  const runId = targetState.run_id;
  await queue.enqueue({
    type: 'start',
    run_id: runId,
    graph_id: targetGraph.id,
    initial_state: targetState,
  });

  // Wait for the target to finish
  const finalState = await new Promise<WorkflowState>((resolve) => {
    const interval = setInterval(async () => {
      const state = await persistence.loadLatestWorkflowState(runId);
      if (state && ['completed', 'failed', 'cancelled', 'timeout'].includes(state.status)) {
        clearInterval(interval);
        resolve(state);
      }
    }, 1000);
  });

  await worker.stop();

  logger.info(`Target workflow finished: status=${finalState.status}, tokens=${finalState.total_tokens_used}`);
  return finalState;
}

// ─── 7. Run the observer workflow ───────────────────────────────────────

async function runObserverWorkflow(targetRunId: string): Promise<WorkflowState> {
  logger.info('Starting observer workflow...');

  await persistence.saveGraph(observerGraph);

  const observerState = state({
    workflowId: observerGraph.id,
    goal: `Triage the workflow run ${targetRunId} — analyze events and state for issues.`,
    maxIterations: 20,
    maxExecutionTimeMs: 120_000,
  });

  // The observer uses middleware to inject target data into its own state
  // before each agent node executes. This keeps the observer read-only —
  // it reads from the shared eventLog and persistence but never writes
  // to the target's state.
  const runner = new GraphRunner(observerGraph, observerState, {
  providers: exampleProviders(),
    registry: agentRegistry,
    persistState: async (s) => { await persistence.saveWorkflowSnapshot(s); },
    eventLog,
    middleware: [{
      beforeNodeExecute: async ({ node, state }) => {
        if (node.type !== 'agent') return;

        // Load target events and summarize them for the agent
        const events = await eventLog.loadEvents(targetRunId);
        const targetState = await persistence.loadLatestWorkflowState(targetRunId);

        // Inject summarized event data (strip large payloads to fit context)
        (state as WorkflowState).memory.target_events = events.map(e => ({
          sequence_id: e.sequence_id,
          event_type: e.event_type,
          node_id: e.node_id ?? null,
          internal_type: e.internal_type ?? null,
          timestamp: e.created_at.toISOString(),
          // Extract token usage from action metadata if present
          action_type: e.action?.type ?? null,
          token_usage: (e.action?.metadata as Record<string, unknown>)?.token_usage ?? null,
          model: (e.action?.metadata as Record<string, unknown>)?.model ?? null,
          duration_ms: (e.action?.metadata as Record<string, unknown>)?.duration_ms ?? null,
        }));

        // Inject state snapshot (metadata only — not full memory contents)
        if (targetState) {
          (state as WorkflowState).memory.target_snapshot = {
            status: targetState.status,
            current_node: targetState.current_node,
            iteration_count: targetState.iteration_count,
            max_iterations: targetState.max_iterations,
            total_tokens_used: targetState.total_tokens_used,
            total_cost_usd: targetState.total_cost_usd,
            visited_nodes: targetState.visited_nodes,
            supervisor_history: targetState.supervisor_history,
            last_error: targetState.last_error,
            memory_keys: Object.keys(targetState.memory),
          };
        }
      },
    }],
  });

  const result = await runner.run();
  logger.info(`Observer workflow finished: status=${result.status}, tokens=${result.total_tokens_used}`);
  return result;
}

// ─── 8. Main ────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║          Workflow Observer Example                    ║');
  console.log('╚══════════════════════════════════════════════════════╝\n');

  // Phase 1: Run the target workflow
  console.log('═══ Phase 1: Target Workflow ═══\n');
  const targetResult = await runTargetWorkflow();

  console.log(`\n  Status:  ${targetResult.status}`);
  console.log(`  Nodes:   ${targetResult.visited_nodes.join(' → ')}`);
  console.log(`  Tokens:  ${targetResult.total_tokens_used}`);
  console.log(`  Cost:    $${(targetResult.total_cost_usd ?? 0).toFixed(4)}`);

  if (targetResult.memory.summary) {
    console.log('\n── Target Output (summary) ──');
    console.log(String(targetResult.memory.summary).slice(0, 500));
    if (String(targetResult.memory.summary).length > 500) console.log('  ...(truncated)');
  }

  // Phase 2: Run the observer workflow
  console.log('\n═══ Phase 2: Observer Workflow ═══\n');
  const observerResult = await runObserverWorkflow(targetResult.run_id);

  console.log(`\n  Status:  ${observerResult.status}`);
  console.log(`  Nodes:   ${observerResult.visited_nodes.join(' → ')}`);
  console.log(`  Tokens:  ${observerResult.total_tokens_used}`);
  console.log(`  Cost:    $${(observerResult.total_cost_usd ?? 0).toFixed(4)}`);

  // Print the triage report
  if (observerResult.memory.triage_report) {
    console.log('\n╔══════════════════════════════════════════════════════╗');
    console.log('║          Triage Report                                ║');
    console.log('╚══════════════════════════════════════════════════════╝\n');
    console.log(observerResult.memory.triage_report);
  }

  // Print combined stats
  console.log('\n═══ Combined Stats ═══');
  console.log(`  Target tokens:    ${targetResult.total_tokens_used}`);
  console.log(`  Observer tokens:  ${observerResult.total_tokens_used}`);
  console.log(`  Total tokens:     ${targetResult.total_tokens_used + observerResult.total_tokens_used}`);
  console.log(`  Total cost:       $${((targetResult.total_cost_usd ?? 0) + (observerResult.total_cost_usd ?? 0)).toFixed(4)}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
