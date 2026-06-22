/**
 * Workflow Observer — Dogfood Example
 *
 * Demonstrates a "triage observer" pattern: a completely separate workflow
 * that reads another workflow's event log and state, then produces a
 * structured triage report — without modifying the target workflow.
 *
 *   1. A target workflow runs (simple supervisor → researcher → writer)
 *   2. After the target completes, the observer workflow analyzes its events
 *   3. Specialist agents triage: token burn, stall detection, error classification
 *   4. A report writer synthesizes findings into a structured triage report
 *
 * Patterns: Supervisor, Read-Only Observation, Middleware Data Injection
 *
 * Prerequisites:
 *   - ANTHROPIC_API_KEY for Claude Sonnet agents
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/workflow-observer/run.ts
 */

import {
  GraphRunner,
  InMemoryPersistenceProvider,
  InMemoryAgentRegistry,
  InMemoryEventLogWriter,
  InMemoryWorkflowQueue,
  WorkflowWorker,
  configureAgentFactory,
  createProviderRegistry,
  configureProviderRegistry,
  createGraph,
  createWorkflowState,
  createLogger,
  type WorkflowState,
} from '@cycgraph/orchestrator';

// ─── 0. Fail fast if no API key ─────────────────────────────────────────

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('Error: ANTHROPIC_API_KEY environment variable is required');
  console.error('Usage: ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/workflow-observer/run.ts');
  process.exit(1);
}

const logger = createLogger('example.observer');

// ─── 1. Shared infrastructure ───────────────────────────────────────────
// Both the target and observer workflows share these instances.
// The observer reads from the same event log and persistence the target writes to.

const persistence = new InMemoryPersistenceProvider();
const eventLog = new InMemoryEventLogWriter();
const queue = new InMemoryWorkflowQueue();
const agentRegistry = new InMemoryAgentRegistry();

// ─── 2. Register target workflow agents ─────────────────────────────────
// A simple 3-agent supervisor workflow (no MCP — runs with just an API key).

const TARGET_SUPERVISOR_ID = agentRegistry.register({
  name: 'Target Supervisor',
  description: 'Routes between researcher and writer',
  model: 'claude-sonnet-4-6',
  provider: 'anthropic',
  systemPrompt: [
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
  tools: [],
  permissions: { readKeys: ['*'], writeKeys: ['*'] },
});

const TARGET_RESEARCHER_ID = agentRegistry.register({
  name: 'Researcher',
  description: 'Produces research notes on a topic using existing knowledge',
  model: 'claude-sonnet-4-6',
  provider: 'anthropic',
  systemPrompt: [
    'You are a research specialist. Produce detailed research notes on the topic in the goal.',
    'Cover key concepts, recent developments, and practical applications.',
  ].join('\n'),
  temperature: 0.5,
  maxSteps: 3,
  tools: [],
  permissions: { readKeys: ['goal'], writeKeys: ['research_notes'] },
});

const TARGET_WRITER_ID = agentRegistry.register({
  name: 'Writer',
  description: 'Writes a polished summary from research notes',
  model: 'claude-sonnet-4-6',
  provider: 'anthropic',
  systemPrompt: [
    'You are a writer. Read the research_notes and produce a concise, polished summary.',
  ].join('\n'),
  temperature: 0.7,
  maxSteps: 3,
  tools: [],
  permissions: { readKeys: ['goal', 'research_notes'], writeKeys: ['summary'] },
});

// ─── 3. Register observer workflow agents ───────────────────────────────

const OBSERVER_SUPERVISOR_ID = agentRegistry.register({
  name: 'Observer Supervisor',
  description: 'Routes between triage specialist agents',
  model: 'claude-sonnet-4-6',
  provider: 'anthropic',
  systemPrompt: [
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
  tools: [],
  permissions: { readKeys: ['*'], writeKeys: ['*'] },
});

const TOKEN_ANALYST_ID = agentRegistry.register({
  name: 'Token Analyst',
  description: 'Analyzes token usage patterns for waste or anomalies',
  model: 'claude-sonnet-4-6',
  provider: 'anthropic',
  systemPrompt: [
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
  tools: [],
  permissions: {
    readKeys: ['target_events', 'target_snapshot'],
    writeKeys: ['token_analysis'],
  },
});

const STALL_DETECTOR_ID = agentRegistry.register({
  name: 'Stall Detector',
  description: 'Detects routing loops, stalls, or anomalous patterns',
  model: 'claude-sonnet-4-6',
  provider: 'anthropic',
  systemPrompt: [
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
  tools: [],
  permissions: {
    readKeys: ['target_events', 'target_snapshot'],
    writeKeys: ['stall_analysis'],
  },
});

const ERROR_CLASSIFIER_ID = agentRegistry.register({
  name: 'Error Classifier',
  description: 'Classifies errors from the workflow run',
  model: 'claude-sonnet-4-6',
  provider: 'anthropic',
  systemPrompt: [
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
  tools: [],
  permissions: {
    readKeys: ['target_events', 'target_snapshot'],
    writeKeys: ['error_analysis'],
  },
});

const REPORT_WRITER_ID = agentRegistry.register({
  name: 'Triage Report Writer',
  description: 'Synthesizes triage findings into a structured report',
  model: 'claude-sonnet-4-6',
  provider: 'anthropic',
  systemPrompt: [
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
  tools: [],
  permissions: {
    readKeys: ['token_analysis', 'stall_analysis', 'error_analysis', 'target_snapshot'],
    writeKeys: ['triage_report'],
  },
});

configureAgentFactory(agentRegistry);

const providers = createProviderRegistry();
configureProviderRegistry(providers);

// ─── 4. Define the target workflow graph ────────────────────────────────

const targetGraph = createGraph({
  name: 'Target: Research & Write',
  description: 'Simple supervisor workflow for the observer to analyze',
  nodes: [
    {
      id: 'supervisor',
      type: 'supervisor',
      agentId: TARGET_SUPERVISOR_ID,
      readKeys: ['*'],
      writeKeys: ['*'],
      supervisorConfig: {
        managedNodes: ['researcher', 'writer'],
        maxIterations: 10,
      },
      failurePolicy: { maxRetries: 1, backoffStrategy: 'exponential', initialBackoffMs: 1000, maxBackoffMs: 30000 },
      requiresCompensation: false,
    },
    {
      id: 'researcher',
      type: 'agent',
      agentId: TARGET_RESEARCHER_ID,
      readKeys: ['goal'],
      writeKeys: ['research_notes'],
      failurePolicy: { maxRetries: 1, backoffStrategy: 'fixed', initialBackoffMs: 1000, maxBackoffMs: 5000 },
      requiresCompensation: false,
    },
    {
      id: 'writer',
      type: 'agent',
      agentId: TARGET_WRITER_ID,
      readKeys: ['goal', 'research_notes'],
      writeKeys: ['summary'],
      failurePolicy: { maxRetries: 1, backoffStrategy: 'fixed', initialBackoffMs: 1000, maxBackoffMs: 5000 },
      requiresCompensation: false,
    },
  ],
  edges: [
    { source: 'supervisor', target: 'researcher' },
    { source: 'supervisor', target: 'writer' },
    { source: 'researcher', target: 'supervisor' },
    { source: 'writer', target: 'supervisor' },
  ],
  startNode: 'supervisor',
  endNodes: [],
});

// ─── 5. Define the observer workflow graph ──────────────────────────────

const observerGraph = createGraph({
  name: 'Workflow Observer',
  description: 'Triage observer that analyzes a completed workflow run',
  nodes: [
    {
      id: 'observer_supervisor',
      type: 'supervisor',
      agentId: OBSERVER_SUPERVISOR_ID,
      readKeys: ['*'],
      writeKeys: ['*'],
      supervisorConfig: {
        managedNodes: ['token_analyst', 'stall_detector', 'error_classifier', 'report_writer'],
        maxIterations: 8,
      },
      failurePolicy: { maxRetries: 1, backoffStrategy: 'fixed', initialBackoffMs: 1000, maxBackoffMs: 5000 },
      requiresCompensation: false,
    },
    {
      id: 'token_analyst',
      type: 'agent',
      agentId: TOKEN_ANALYST_ID,
      readKeys: ['target_events', 'target_snapshot'],
      writeKeys: ['token_analysis'],
      failurePolicy: { maxRetries: 1, backoffStrategy: 'fixed', initialBackoffMs: 1000, maxBackoffMs: 5000 },
      requiresCompensation: false,
    },
    {
      id: 'stall_detector',
      type: 'agent',
      agentId: STALL_DETECTOR_ID,
      readKeys: ['target_events', 'target_snapshot'],
      writeKeys: ['stall_analysis'],
      failurePolicy: { maxRetries: 1, backoffStrategy: 'fixed', initialBackoffMs: 1000, maxBackoffMs: 5000 },
      requiresCompensation: false,
    },
    {
      id: 'error_classifier',
      type: 'agent',
      agentId: ERROR_CLASSIFIER_ID,
      readKeys: ['target_events', 'target_snapshot'],
      writeKeys: ['error_analysis'],
      failurePolicy: { maxRetries: 1, backoffStrategy: 'fixed', initialBackoffMs: 1000, maxBackoffMs: 5000 },
      requiresCompensation: false,
    },
    {
      id: 'report_writer',
      type: 'agent',
      agentId: REPORT_WRITER_ID,
      readKeys: ['token_analysis', 'stall_analysis', 'error_analysis', 'target_snapshot'],
      writeKeys: ['triage_report'],
      failurePolicy: { maxRetries: 1, backoffStrategy: 'fixed', initialBackoffMs: 1000, maxBackoffMs: 5000 },
      requiresCompensation: false,
    },
  ],
  edges: [
    { source: 'observer_supervisor', target: 'token_analyst' },
    { source: 'observer_supervisor', target: 'stall_detector' },
    { source: 'observer_supervisor', target: 'error_classifier' },
    { source: 'observer_supervisor', target: 'report_writer' },
    { source: 'token_analyst', target: 'observer_supervisor' },
    { source: 'stall_detector', target: 'observer_supervisor' },
    { source: 'error_classifier', target: 'observer_supervisor' },
    { source: 'report_writer', target: 'observer_supervisor' },
  ],
  startNode: 'observer_supervisor',
  endNodes: [],
});

// ─── 6. Run the target workflow ─────────────────────────────────────────

async function runTargetWorkflow(): Promise<WorkflowState> {
  logger.info('Starting target workflow...');

  await persistence.saveGraph(targetGraph);

  const targetState = createWorkflowState({
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
    runnerOptionsFactory: () => ({}),
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

  const observerState = createWorkflowState({
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
    persistStateFn: async (s) => { await persistence.saveWorkflowSnapshot(s); },
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
