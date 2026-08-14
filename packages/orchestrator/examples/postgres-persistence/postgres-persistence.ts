/**
 * Postgres Persistence — durable state, event log, and usage tracking.
 *
 * Run:  docker-compose up -d && DATABASE_URL=... ANTHROPIC_API_KEY=... \
 *         npx tsx examples/postgres-persistence/postgres-persistence.ts
 * See:  ./README.md for the tables written and how replay differs from resume.
 */

import {
  node,
  graph,
  state,
  GraphRunner,
  createLogger,
} from '@cycgraph/orchestrator';
import { MODEL, PROVIDER, exampleProviders, missingCredentials } from '../_model.js';

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

const missing = missingCredentials();
if (missing) {
  console.error(`Error: ${missing}`);
  process.exit(1);
}

const logger = createLogger('example.postgres');

// ─── 1. Postgres-backed providers ───────────────────────────────────────
// The adapters share a lazily-initialized connection pool. Construct them
// with no arguments (pass `{ tenant }` for multi-tenant deployments); the
// pool is initialized once via `await getDb()` at the start of `main()`.

const persistence = new DrizzlePersistenceProvider();
const eventLog = new DrizzleEventLogWriter();
const usageRecorder = new DrizzleUsageRecorder();

// Use Postgres-backed agent registry (agents stored in DB, not in-memory)
const agentRegistry = new DrizzleAgentRegistry();

// ─── 2. Register agents in Postgres ─────────────────────────────────────
// These persist across restarts — no need to re-register each time.

async function ensureAgentsRegistered() {
  // Check if agents already exist (idempotent registration)
  const existing = await agentRegistry.listAgents();
  if (existing.some(a => a.name === 'PG Research Agent')) {
    logger.info('Agents already registered in Postgres');
    const researcher = existing.find(a => a.name === 'PG Research Agent')!;
    const writer = existing.find(a => a.name === 'PG Writer Agent')!;
    return { RESEARCHER_ID: researcher.id, WRITER_ID: writer.id };
  }

  const RESEARCHER_ID = await agentRegistry.register({
    name: 'PG Research Agent',
    description: 'Researches topics (Postgres-persisted)',
    model: MODEL,
    provider: PROVIDER,
    provider: 'anthropic',
    systemPrompt: [
      'You are a research specialist.',
      'Produce concise, factual research notes on the given topic.',
    ].join(' '),
    temperature: 0.5,
    maxSteps: 3,
    tools: [],
    permissions: {
      readKeys: ['*'],
      writeKeys: ['research_notes'],
    },
  });

  const WRITER_ID = await agentRegistry.register({
    name: 'PG Writer Agent',
    description: 'Writes articles from research (Postgres-persisted)',
    model: MODEL,
    provider: PROVIDER,
    provider: 'anthropic',
    systemPrompt: [
      'You are a professional writer.',
      'Using the research notes, produce a clear article under 300 words.',
    ].join(' '),
    temperature: 0.7,
    maxSteps: 3,
    tools: [],
    permissions: {
      readKeys: ['research_notes'],
      writeKeys: ['article'],
    },
  });

  logger.info('Agents registered in Postgres', { RESEARCHER_ID, WRITER_ID });
  return { RESEARCHER_ID, WRITER_ID };
}

// ─── 3. Main ────────────────────────────────────────────────────────────

async function main() {
  logger.info('Starting Postgres persistence example...\n');

  // Initialize the shared connection pool before any adapter runs a query.
  await getDb();

  const { RESEARCHER_ID, WRITER_ID } = await ensureAgentsRegistered();

  // Author the graph with the facade, referencing the Postgres-stored agent
  // ids by string. The node's reads/writes are the authoritative grant.
  const research = node({
    id: 'research',
    agent: RESEARCHER_ID,
    reads: ['*'],
    writes: 'research_notes',
    failurePolicy: { maxRetries: 2, maxBackoffMs: 30000 },
  });

  const write = node({
    id: 'write',
    agent: WRITER_ID,
    reads: ['research_notes'],
    writes: 'article',
    failurePolicy: { maxRetries: 2, maxBackoffMs: 30000 },
  });

  const workflow = graph({
    name: 'Postgres Workflow',
    description: 'Research → Write with Postgres persistence',
    nodes: [research, write],
    edges: [{ from: research, to: write }],
  });

  // Save graph definition to Postgres
  await persistence.saveGraph(workflow);
  logger.info('Graph saved to Postgres', { graph_id: workflow.id });

  // Create workflow state
  const initialState = state({
    workflowId: workflow.id,
    goal: 'Research and write about the impact of large language models on software development',
    constraints: ['Under 300 words'],
    maxExecutionTimeMs: 120_000,
  });

  // Create runner with Postgres persistence + event log
  const runner = new GraphRunner(workflow, initialState, {
  providers: exampleProviders(),
    // Scope the Postgres-backed agent registry to this run
    registry: agentRegistry,
    // State is persisted to Postgres after every step (enables crash recovery)
    persistState: async (s) => {
      await persistence.saveWorkflowState(s);
      await persistence.saveWorkflowRun(s);
    },
    // Event log enables durable execution replay
    eventLog: eventLog,
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
    await usageRecorder.saveUsageRecord({
      run_id: finalState.run_id,
      graph_id: workflow.id,
      input_tokens: 0,  // Actual breakdown would come from action metadata
      output_tokens: 0,
      cost_usd: finalState.total_cost_usd,
      duration_ms: 0,
    });

    console.log('\n═══ Postgres Verification ═══');

    // Verify state was persisted
    const savedState = await persistence.loadLatestWorkflowState(finalState.run_id);
    console.log('State persisted:', savedState ? 'YES' : 'NO');

    // Verify events were logged
    const events = await eventLog.loadEvents(finalState.run_id);
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
