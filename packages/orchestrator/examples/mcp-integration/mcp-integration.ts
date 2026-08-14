/**
 * MCP Integration — agents calling tools from MCP servers, with taint tracking.
 *
 * Run:  BRAVE_API_KEY=BSA-... ANTHROPIC_API_KEY=sk-ant-... \
 *         npx tsx examples/mcp-integration/mcp-integration.ts
 * See:  ./README.md for what the servers are and how taint propagates.
 */

import {
  agent,
  node,
  graph,
  state,
  agentsForGraph,
  GraphRunner,
  InMemoryAgentRegistry,
  InMemoryMCPServerRegistry,
  MCPConnectionManager,
  registerDefaultMCPServers,
  createLogger,
} from '@cycgraph/orchestrator';
import { MODEL, PROVIDER, exampleProviders, missingCredentials } from '../_model.js';

// ─── 0. Fail fast if no API keys ────────────────────────────────────────

const missing = missingCredentials();
if (missing) {
  console.error(`Error: ${missing}`);
  process.exit(1);
}

if (!process.env.BRAVE_API_KEY) {
  console.warn('Warning: BRAVE_API_KEY not set — web search will fail at runtime.');
  console.warn('Get a free key at https://brave.com/search/api/\n');
}

const logger = createLogger('example.mcp');

// ─── 1. Register MCP servers with one call ──────────────────────────────

const mcpRegistry = new InMemoryMCPServerRegistry();
const registered = await registerDefaultMCPServers(mcpRegistry);
logger.info(`Registered MCP servers: ${registered.join(', ')}`);


// ─── 2. Define agents with MCP tool references ──────────────────────────
// The MCPConnectionManager resolves these at execution time by connecting to the
// registered servers.

// Research agent: uses web-search MCP server + fetch MCP server
const researcher = agent({
  name: 'Web Research Agent',
  description: 'Researches topics using web search and URL fetching',
  model: MODEL,
    provider: PROVIDER,
  instructions: [
    'You are a research agent with access to web search and URL fetching.',
    'Use brave_web_search to find current information about the topic.',
    'Use fetch to read specific URLs when you need deeper content from a search result.',
    'Synthesize your findings into concise, factual research notes.',
  ].join(' '),
  temperature: 0.5,
  maxSteps: 8, // More steps to allow search → fetch → summarize chains
  tools: [
    { mcp: 'web-search' }, // Brave web search
    { mcp: 'fetch' }, // URL content fetching
  ],
});

// Writer agent: no MCP tools needed, just processes research notes
const writer = agent({
  name: 'Summary Writer',
  description: 'Writes concise summaries from research notes',
  model: MODEL,
    provider: PROVIDER,
  instructions: [
    'You are a writer. Using the research notes, produce a clear, well-structured summary.',
    'Include key facts and cite sources when available.',
  ].join(' '),
  temperature: 0.7,
  maxSteps: 3,
});

// ─── 3. Create the MCPConnectionManager ─────────────────────────────────
// Connects to MCP servers lazily on first tool use.
// IMPORTANT: call mcpManager.closeAll() when done to clean up child processes.

const mcpManager = new MCPConnectionManager(mcpRegistry);

// ─── 4. Define the graph ────────────────────────────────────────────────

const research = node({
  id: 'research',
  agent: researcher,
  reads: ['*'],
  writes: 'research_notes',
  failurePolicy: { maxRetries: 2, initialBackoffMs: 2000, maxBackoffMs: 30000 },
});

const write = node({
  id: 'write',
  agent: writer,
  reads: ['research_notes'],
  writes: 'summary',
  failurePolicy: { maxRetries: 2, maxBackoffMs: 30000 },
});

const workflow = graph({
  name: 'Web Research Pipeline',
  description: 'Search + fetch → research notes → written summary',
  nodes: [research, write],
  edges: [{ from: research, to: write }],
  // Taint tracking: MCP tool outputs are automatically marked as tainted.
  // strict_taint rejects routing decisions that depend on tainted data.
  strictTaint: true,
});

// Hybrid pattern: register the facade-minted agent configs into a run-scoped
// registry for the GraphRunner this example keeps.
const agentRegistry = new InMemoryAgentRegistry();
for (const config of agentsForGraph(workflow)) agentRegistry.register(config);

// ─── 5. Run ─────────────────────────────────────────────────────────────

async function main() {
  logger.info('Starting web research pipeline...\n');

  const initialState = state({
    workflowId: workflow.id,
    goal: 'Research the Model Context Protocol (MCP): what it is, who introduced it, and how it lets tools connect to LLMs. Summarize the key facts.',
    constraints: ['Keep the summary under 300 words', 'Include specific facts and sources'],
    maxExecutionTimeMs: 120_000,
  });

  const runner = new GraphRunner(workflow, initialState, {
  providers: exampleProviders(),
    registry: agentRegistry,
    tools: [mcpManager],
  });

  // ─── Tool call streaming: real-time visibility into MCP tool activity ──
  runner.on('tool:call_start', (event) => {
    console.log(`  ⚙ [${event.node_id}] Tool call started: ${event.tool_name} (${event.tool_call_id})`);
  });

  runner.on('tool:call_finish', (event) => {
    const status = event.success ? 'OK' : `FAILED: ${event.error}`;
    console.log(`  ✓ [${event.node_id}] Tool call finished: ${event.tool_name} — ${status} (${event.duration_ms}ms)`);
  });

  try {
    const finalState = await runner.run();

    console.log('\n═══ Results ═══');
    console.log('Status:', finalState.status);
    console.log('\nResearch Notes:');
    console.log(finalState.memory.research_notes ?? '(none)');
    console.log('\nSummary:');
    console.log(finalState.memory.summary ?? '(none)');

    // Show taint tracking (MCP tool outputs are automatically tainted)
    const taintRegistry = finalState.taint_registry as Record<string, unknown> | undefined;
    if (taintRegistry && Object.keys(taintRegistry).length > 0) {
      console.log('\n═══ Taint Registry ═══');
      console.log('(MCP-sourced data automatically tracked for provenance)');
      for (const [key, meta] of Object.entries(taintRegistry)) {
        console.log(`  ${key}: ${JSON.stringify(meta)}`);
      }
    }

    console.log('\n═══ Stats ═══');
    console.log(`  Nodes visited: ${finalState.visited_nodes.join(' → ')}`);
    console.log(`  Tokens used:   ${finalState.total_tokens_used}`);
    console.log(`  Cost (USD):    $${finalState.total_cost_usd.toFixed(4)}`);
  } catch (err) {
    console.error('Error:', err);
    process.exit(1);
  } finally {
    // Always clean up MCP connections (kills stdio child processes)
    await mcpManager.closeAll();
  }
}

main();
