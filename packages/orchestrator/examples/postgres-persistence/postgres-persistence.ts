/**
 * Postgres Persistence — Runnable Example
 *
 * Demonstrates how to use the `@cycgraph/orchestrator-postgres` adapter for
 * durable state persistence, event sourcing, and usage tracking with a
 * real PostgreSQL database.
 *
 * Demonstrates: DrizzlePersistenceProvider, DrizzleEventLogWriter,
 * DrizzleUsageRecorder, DrizzleAgentRegistry, state checkpointing,
 * event replay, and cost/token tracking.
 *
 * Prerequisites:
 *   docker-compose up -d   # Start Postgres on localhost:5433
 *   npm run db:migrate      # Apply schema migrations
 *
 * Usage:
 *   DATABASE_URL=postgres://... ANTHROPIC_API_KEY=sk-ant-... \
 *     npx tsx examples/postgres-persistence/postgres-persistence.ts
 */

import {
  GraphRunner,
  configureAgentFactory,
  createProviderRegistry,
  configureProviderRegistry,
  createGraph,
  createWorkflowState,
  createLogger,
} from '@cycgraph/orchestrator';

import {
  getDb,
  closeDb,
  DrizzlePersistenceProvider,
  DrizzleEventLogWriter,
  DrizzleUsageRecorder,
  DrizzleAgentRegistry,
} from '@cycgraph/orchestrator-postgres';

// ─── 0. Validate environment ─────────────────────────────────────────────

if (!process.env.DATABASE_URL) {
  console.error('Error: DATABASE_URL environment variable is required');
  console.error('Example: DATABASE_URL=postgres://postgres:postgres@localhost:5433/mc_ai');
  console.error('Run: docker-compose up -d && npm run db:migrate');
  process.exit(1);
}

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('Error: ANTHROPIC_API_KEY environment variable is required');
  process.exit(1);
}

const logger = createLogger('example.postgres');

// ─── 1. Initialize Postgres connection ──────────────────────────────────

const db = getDb();

// Create persistence providers backed by Postgres
const persistence = new DrizzlePersistenceProvider(db);
const eventLog = new DrizzleEventLogWriter(db);
const usageRecorder = new DrizzleUsageRecorder(db);

// Use Postgres-backed agent registry (agents stored in DB, not in-memory)
const agentRegistry = new DrizzleAgentRegistry(db);

// ─── 2. Register agents in Postgres ─────────────────────────────────────
// These persist across restarts — no need to re-register each time.

async function ensureAgentsRegistered() {
  // Check if agents already exist (idempotent registration)
  const existing = await agentRegistry.list();
  if (existing.some(a => a.name === 'PG Research Agent')) {
    logger.info('Agents already registered in Postgres');
    const researcher = existing.find(a => a.name === 'PG Research Agent')!;
    const writer = existing.find(a => a.name === 'PG Writer Agent')!;
    return { RESEARCHER_ID: researcher.id, WRITER_ID: writer.id };
  }

  const RESEARCHER_ID = await agentRegistry.register({
    name: 'PG Research Agent',
    description: 'Researches topics (Postgres-persisted)',
    model: 'claude-sonnet-4-6',
    provider: 'anthropic',
    system_prompt: [
      'You are a research specialist.',
      'Produce concise, factual research notes on the given topic.',
    ].join(' '),
    temperature: 0.5,
    max_steps: 3,
    tools: [],
    permissions: {
      read_keys: ['*'],
      write_keys: ['research_notes'],
    },
  });

  const WRITER_ID = await agentRegistry.register({
    name: 'PG Writer Agent',
    description: 'Writes articles from research (Postgres-persisted)',
    model: 'claude-sonnet-4-6',
    provider: 'anthropic',
    system_prompt: [
      'You are a professional writer.',
      'Using the research notes, produce a clear article under 300 words.',
    ].join(' '),
    temperature: 0.7,
    max_steps: 3,
    tools: [],
    permissions: {
      read_keys: ['research_notes'],
      write_keys: ['article'],
    },
  });

  logger.info('Agents registered in Postgres', { RESEARCHER_ID, WRITER_ID });
  return { RESEARCHER_ID, WRITER_ID };
}

// ─── 3. Main ────────────────────────────────────────────────────────────

async function main() {
  logger.info('Starting Postgres persistence example...\n');

  const { RESEARCHER_ID, WRITER_ID } = await ensureAgentsRegistered();

  // Configure the agent factory to use the Postgres-backed registry
  configureAgentFactory(agentRegistry);
  const providers = createProviderRegistry();
  configureProviderRegistry(providers);

  // Define graph
  const graph = createGraph({
    name: 'Postgres Workflow',
    description: 'Research → Write with Postgres persistence',
    nodes: [
      {
        id: 'research',
        type: 'agent',
        agent_id: RESEARCHER_ID,
        read_keys: ['*'],
        write_keys: ['research_notes'],
        failure_policy: { max_retries: 2, backoff_strategy: 'exponential', initial_backoff_ms: 1000, max_backoff_ms: 30000 },
        requires_compensation: false,
      },
      {
        id: 'write',
        type: 'agent',
        agent_id: WRITER_ID,
        read_keys: ['research_notes'],
        write_keys: ['article'],
        failure_policy: { max_retries: 2, backoff_strategy: 'exponential', initial_backoff_ms: 1000, max_backoff_ms: 30000 },
        requires_compensation: false,
      },
    ],
    edges: [{ source: 'research', target: 'write' }],
    start_node: 'research',
    end_nodes: ['write'],
  });

  // Save graph definition to Postgres
  await persistence.saveGraph(graph);
  logger.info('Graph saved to Postgres', { graph_id: graph.id });

  // Create workflow state
  const state = createWorkflowState({
    workflow_id: graph.id,
    goal: 'Research and write about the impact of large language models on software development',
    constraints: ['Under 300 words'],
    max_execution_time_ms: 120_000,
  });

  // Create runner with Postgres persistence + event log
  const runner = new GraphRunner(graph, state, {
    // State is persisted to Postgres after every step (enables crash recovery)
    persistStateFn: async (s) => {
      await persistence.saveWorkflowState(s);
      await persistence.saveWorkflowRun(s);
    },
    // Event log enables durable execution replay
    eventLogWriter: eventLog,
  });

  // Run the workflow
  try {
    const finalState = await runner.run();

    console.log('\n═══ Results ═══');
    console.log('Status:', finalState.status);
    console.log('Run ID:', finalState.run_id);

    console.log('\nResearch Notes:');
    console.log(finalState.memory.research_notes ?? '(none)');

    console.log('\nArticle:');
    console.log(finalState.memory.article ?? '(none)');

    // Record usage to Postgres (for billing/analytics)
    await usageRecorder.record({
      run_id: finalState.run_id,
      graph_id: graph.id,
      input_tokens: 0,  // Actual breakdown would come from action metadata
      output_tokens: 0,
      cost_usd: finalState.total_cost_usd,
      model_breakdown: {},
    });

    console.log('\n═══ Postgres Verification ═══');

    // Verify state was persisted
    const savedState = await persistence.getLatestWorkflowState(finalState.run_id);
    console.log('State persisted:', savedState ? 'YES' : 'NO');

    // Verify events were logged
    const events = await eventLog.getEvents(finalState.run_id);
    console.log('Events logged:', events.length);

    console.log(`\nTokens used: ${finalState.total_tokens_used}`);
    console.log(`Cost (USD):  $${finalState.total_cost_usd.toFixed(4)}`);
  } catch (err) {
    console.error('Error:', err);
    process.exit(1);
  } finally {
    await closeDb();
    logger.info('Postgres connection closed');
  }
}

main();
