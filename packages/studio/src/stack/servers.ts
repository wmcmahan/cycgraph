/**
 * Scenario server registration
 *
 * Populates the A2A and MCP registries from the servers Docker Compose is
 * running. Endpoints resolve through a trusted registry, never inline URLs,
 * so this is the only place a playground scenario's remote address is decided.
 *
 * @module stack/servers
 */

import { z } from 'zod';
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

/** The scenario server's index, as far as registration needs it. */
const scenarioIndexSchema = z.object({
  agents: z.array(z.object({ id: z.string() })),
});

/**
 * Which scenarios the running server currently advertises.
 *
 * A model-backed scenario's Agent Card is withheld with a 503 while no model
 * is reachable, so registering the full list would hand the engine an
 * endpoint whose card resolution fails before a task is ever created.
 *
 * Falls back to every known scenario when the index cannot be read: that is
 * the server being broken rather than a scenario being unavailable, and the
 * card fetch reports it better than a silently empty registry would.
 */
async function advertisedScenarios(baseUrl: string): Promise<readonly string[]> {
  try {
    const response = await fetch(baseUrl, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return A2A_SCENARIOS;
    const index = scenarioIndexSchema.parse(await response.json());
    const served = new Set(index.agents.map((agent) => agent.id));
    return A2A_SCENARIOS.filter((id) => served.has(id));
  } catch {
    return A2A_SCENARIOS;
  }
}

/**
 * Register the A2A scenario agents the server is serving.
 *
 * The servers bind loopback, which the engine's SSRF guard blocks by design,
 * so the development opt-out is set here. That is the guard working, not a
 * bug to route around silently.
 */
export async function registerA2AScenarios(baseUrl: string): Promise<A2AServerRegistry> {
  process.env['CYCGRAPH_ALLOW_PRIVATE_A2A_URLS'] = 'true';

  const registry = new InMemoryA2AServerRegistry();
  for (const id of await advertisedScenarios(baseUrl)) {
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
    // Strictly above the `slow` tool's 30s sleep cap, with margin for the
    // round trip the client's clock counts but the server's sleep does not,
    // so a scenario trips the engine's per-tool timeout rather than the
    // connection giving up first.
    timeoutMs: 35_000,
  });
  return registry;
}
