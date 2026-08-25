/**
 * Scenario server registration
 *
 * Populates the A2A and MCP registries from the servers Docker Compose is
 * running. Endpoints resolve through a trusted registry, never inline URLs,
 * so this is the only place a playground scenario's remote address is decided.
 *
 * @module stack/servers
 */

import {
  InMemoryA2AServerRegistry,
  InMemoryMCPServerRegistry,
  type A2AServerRegistry,
  type MCPServerRegistry,
} from '@cycgraph/orchestrator';

/**
 * The scenarios `packages/test-servers` serves, by id.
 *
 * Duplicated rather than imported: the playground registers against a running
 * server it does not build, and a workspace dependency on a private package
 * would tie the two together for a list of seven strings.
 */
export const A2A_SCENARIOS = [
  // Scripted outcomes: what the protocol has to survive.
  'echo',
  'multi-artifact',
  'asks-question',
  'rejects',
  'fails',
  'needs-auth',
  'unnamed-artifact',
  // A real model on the far side: what delegation is for.
  'agent',
  'agent-clarifies',
] as const;

/** Id under which the scenario MCP server is registered. */
export const MCP_SERVER_ID = 'scenario-mcp';

/**
 * Register every A2A scenario agent.
 *
 * The servers bind loopback, which the engine's SSRF guard blocks by design,
 * so the development opt-out is set here. That is the guard working, not a
 * bug to route around silently.
 */
export async function registerA2AScenarios(baseUrl: string): Promise<A2AServerRegistry> {
  process.env['CYCGRAPH_ALLOW_PRIVATE_A2A_URLS'] = 'true';

  const registry = new InMemoryA2AServerRegistry();
  for (const id of A2A_SCENARIOS) {
    await registry.saveServer({
      id,
      name: id,
      agentCardUrl: `${baseUrl}/${id}/.well-known/agent-card.json`,
    });
  }
  return registry;
}

/** Register the scenario MCP server, whose tools cover timeout and failure paths. */
export async function registerMCPScenarios(baseUrl: string): Promise<MCPServerRegistry> {
  process.env['CYCGRAPH_ALLOW_PRIVATE_MCP_URLS'] = 'true';

  const registry = new InMemoryMCPServerRegistry();
  await registry.saveServer({
    id: MCP_SERVER_ID,
    name: 'Scenario MCP server',
    transport: { type: 'http', url: `${baseUrl}/mcp` },
    // Above the `slow` tool's sleep, so per-tool timeouts are what a scenario
    // trips rather than the connection giving up first.
    timeoutMs: 30_000,
  });
  return registry;
}
