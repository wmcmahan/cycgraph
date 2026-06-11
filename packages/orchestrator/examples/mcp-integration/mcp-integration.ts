/**
 * MCP Integration — Runnable Example
 *
 * Demonstrates how to use the built-in default MCP servers (web search
 * and web fetch) with agents. Uses `registerDefaultMCPServers()` for
 * one-line setup, then declares tool references via `ToolSource[]`.
 *
 * Web search uses @modelcontextprotocol/server-brave-search (npm/npx).
 * Fetch uses mcp-server-fetch (Python/uvx).
 *
 * Demonstrates: registerDefaultMCPServers, MCPConnectionManager,
 * ToolSource declarations, taint tracking, connection lifecycle.
 *
 * Prerequisites:
 *   - BRAVE_API_KEY for web search (get one at https://brave.com/search/api/)
 *   - ANTHROPIC_API_KEY for the LLM agents
 *
 * Usage:
 *   BRAVE_API_KEY=BSA-... ANTHROPIC_API_KEY=sk-ant-... \
 *     npx tsx examples/mcp-integration/mcp-integration.ts
 */

import {
  GraphRunner,
  InMemoryAgentRegistry,
  InMemoryMCPServerRegistry,
  configureAgentFactory,
  createProviderRegistry,
  configureProviderRegistry,
  MCPConnectionManager,
  registerDefaultMCPServers,
  createGraph,
  createWorkflowState,
  createLogger,
} from '@cycgraph/orchestrator';
import type { ToolSource } from '@cycgraph/orchestrator';

// ─── 0. Fail fast if no API keys ────────────────────────────────────────

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('Error: ANTHROPIC_API_KEY environment variable is required');
  process.exit(1);
}

if (!process.env.BRAVE_API_KEY) {
  console.warn('Warning: BRAVE_API_KEY not set — web search will fail at runtime.');
  console.warn('Get a free key at https://brave.com/search/api/\n');
}

const logger = createLogger('example.mcp');

// ─── 1. Register MCP servers with one call ──────────────────────────────
// registerDefaultMCPServers() sets up pre-configured servers for:
//   - web-search: Brave Search via @modelcontextprotocol/server-brave-search (npx)
//   - fetch: URL content extraction via mcp-server-fetch (uvx)
//
// Servers use stdio transport — packages are resolved on-the-fly.

const mcpRegistry = new InMemoryMCPServerRegistry();
const registered = await registerDefaultMCPServers(mcpRegistry);
logger.info(`Registered MCP servers: ${registered.join(', ')}`);

// You can also register selectively or with overrides:
//   registerDefaultMCPServers(mcpRegistry, { only: ['fetch'] });
//   registerDefaultMCPServers(mcpRegistry, { brave_api_key: 'BSA-...' });
//   registerDefaultMCPServers(mcpRegistry, { allowed_agents: [RESEARCHER_ID] });

// ─── 2. Register agents with MCP tool references ────────────────────────
// Tools are declared as ToolSource[] — the MCPConnectionManager resolves
// them at execution time by connecting to the registered servers.

const agentRegistry = new InMemoryAgentRegistry();

// Research agent: uses web-search MCP server + fetch MCP server
const RESEARCHER_ID = agentRegistry.register({
  name: 'Web Research Agent',
  description: 'Researches topics using web search and URL fetching',
  model: 'claude-sonnet-4-20250514',
  provider: 'anthropic',
  system_prompt: [
    'You are a research agent with access to web search and URL fetching.',
    'Use brave_web_search to find current information about the topic.',
    'Use fetch to read specific URLs when you need deeper content from a search result.',
    'Synthesize your findings into concise, factual research notes.',
  ].join(' '),
  temperature: 0.5,
  max_steps: 8, // More steps to allow search → fetch → summarize chains
  tools: [
    // { type: 'mcp', server_id: 'web-search' },  // Brave web search
    { type: 'mcp', server_id: 'fetch' },       // URL content fetching
  ] satisfies ToolSource[],
  permissions: {
    read_keys: ['*'],
    write_keys: ['research_notes'],
  },
});

// Writer agent: no MCP tools needed, just processes research notes
const WRITER_ID = agentRegistry.register({
  name: 'Summary Writer',
  description: 'Writes concise summaries from research notes',
  model: 'claude-sonnet-4-20250514',
  provider: 'anthropic',
  system_prompt: [
    'You are a writer. Using the research notes, produce a clear, well-structured summary.',
    'Include key facts and cite sources when available.',
  ].join(' '),
  temperature: 0.7,
  max_steps: 3,
  tools: [],
  permissions: {
    read_keys: ['research_notes'],
    write_keys: ['summary'],
  },
});

configureAgentFactory(agentRegistry);
const providers = createProviderRegistry();
configureProviderRegistry(providers);

// ─── 3. Create the MCPConnectionManager ─────────────────────────────────
// Connects to MCP servers lazily on first tool use.
// IMPORTANT: call mcpManager.closeAll() when done to clean up child processes.

const mcpManager = new MCPConnectionManager(mcpRegistry);

// ─── 4. Define the graph ────────────────────────────────────────────────

const graph = createGraph({
  name: 'Web Research Pipeline',
  description: 'Search + fetch → research notes → written summary',

  nodes: [
    {
      id: 'research',
      type: 'agent',
      agent_id: RESEARCHER_ID,
      read_keys: ['*'],
      write_keys: ['research_notes'],
      failure_policy: { max_retries: 2, backoff_strategy: 'exponential', initial_backoff_ms: 2000, max_backoff_ms: 30000 },
      requires_compensation: false,
    },
    {
      id: 'write',
      type: 'agent',
      agent_id: WRITER_ID,
      read_keys: ['research_notes'],
      write_keys: ['summary'],
      failure_policy: { max_retries: 2, backoff_strategy: 'exponential', initial_backoff_ms: 1000, max_backoff_ms: 30000 },
      requires_compensation: false,
    },
  ],

  edges: [
    { source: 'research', target: 'write' },
  ],

  start_node: 'research',
  end_nodes: ['write'],

  // Taint tracking: MCP tool outputs are automatically marked as tainted.
  // strict_taint rejects routing decisions that depend on tainted data.
  strict_taint: true,
});

// ─── 5. Run ─────────────────────────────────────────────────────────────

async function main() {
  logger.info('Starting web research pipeline...\n');

  const state = createWorkflowState({
    workflow_id: graph.id,
    goal: 'Research the Gitlab website (https://github.com/wmcmahan/cycgraph) and give me summary of the site.',
    constraints: ['Keep the summary under 300 words', 'Include specific facts and sources'],
    max_execution_time_ms: 120_000,
  });

  const runner = new GraphRunner(graph, state, {
    toolResolver: mcpManager,
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
    const taintRegistry = finalState.memory._taint_registry as Record<string, unknown> | undefined;
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
