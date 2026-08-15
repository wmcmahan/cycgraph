/**
 * Test server CLI
 *
 * Starts every protocol server on one port each, so integration tests and
 * manual exploration have somewhere real to point at.
 *
 *   npm run start --workspace=packages/test-servers
 *
 * Both servers bind to localhost, which the engine's SSRF guards block by
 * default. That is the guard working as designed; set the matching
 * development opt-out to use them:
 *
 *   CYCGRAPH_ALLOW_PRIVATE_A2A_URLS=true
 *   CYCGRAPH_ALLOW_PRIVATE_MCP_URLS=true
 *
 * @module cli
 */

import { createA2AScenarioServer } from './a2a/server.js';
import { createMCPScenarioServer, MCP_TOOLS } from './mcp/server.js';
import { SCENARIOS } from './a2a/scenarios.js';

const A2A_PORT = Number(process.env.A2A_PORT ?? 4001);
const MCP_PORT = Number(process.env.MCP_PORT ?? 4002);
const HOST = process.env.TEST_SERVER_HOST ?? '127.0.0.1';

// Agent Cards advertise this, so it must be an address the CLIENT can reach.
// In a container the bind host is `0.0.0.0`, which no client can fetch from,
// so the published URL is configured separately from the bind address.
const a2aBase = process.env.A2A_PUBLIC_URL ?? `http://${HOST}:${A2A_PORT}`;

createA2AScenarioServer(a2aBase).listen(A2A_PORT, HOST, () => {
  console.log(`\nA2A scenario agents  →  ${a2aBase}`);
  for (const scenario of SCENARIOS) {
    console.log(`  ${scenario.id.padEnd(18)} ${a2aBase}/${scenario.id}/.well-known/agent-card.json`);
  }
});

createMCPScenarioServer().listen(MCP_PORT, HOST, () => {
  console.log(`\nMCP scenario server  →  http://${HOST}:${MCP_PORT}/mcp`);
  console.log(`  tools: ${MCP_TOOLS.map((t) => t.name).join(', ')}\n`);
  console.log('Remember the development opt-outs:');
  console.log('  CYCGRAPH_ALLOW_PRIVATE_A2A_URLS=true  CYCGRAPH_ALLOW_PRIVATE_MCP_URLS=true\n');
});
