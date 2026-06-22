/**
 * Default MCP Server Configurations
 *
 * Pre-configured MCP server entries for commonly needed capabilities.
 * These use well-known official MCP reference servers and can be registered
 * into any {@link MCPServerRegistry} via {@link registerDefaultMCPServers}.
 *
 * Servers are started as child processes via stdio transport:
 * - **web-search** — npm package via `npx` (@modelcontextprotocol/server-brave-search)
 * - **fetch** — Python package via `uvx` (mcp-server-fetch)
 *
 * Available defaults:
 * - **web-search** — Web search via Brave Search API
 * - **fetch** — Fetch and extract content from URLs
 *
 * @module mcp/default-servers
 */

import type { MCPServerEntry, MCPServerConfig } from '../types/tools.js';
import type { MCPServerRegistry } from '../persistence/interfaces.js';

// ─── Server Definitions ─────────────────────────────────────────────

/**
 * Web Search MCP server configuration.
 *
 * Uses `@modelcontextprotocol/server-brave-search` (stdio transport via npx).
 * Requires `BRAVE_API_KEY` environment variable for the Brave Search API.
 *
 * Tools provided:
 * - `brave_web_search` — Search the web and return results
 *
 * @see https://github.com/modelcontextprotocol/servers/tree/main/src/brave-search
 */
export const WEB_SEARCH_SERVER: MCPServerEntry = {
  id: 'web-search',
  name: 'Web Search',
  description: 'Web search via Brave Search API. Requires BRAVE_API_KEY env var.',
  transport: {
    type: 'stdio',
    command: 'npx',
    args: ['--silent', '-y', '@modelcontextprotocol/server-brave-search'],
    env: {
      // BRAVE_API_KEY is forwarded from the host environment at connection time.
      // The MCPConnectionManager passes env vars to the stdio child process.
      ...(process.env.BRAVE_API_KEY ? { BRAVE_API_KEY: process.env.BRAVE_API_KEY } : {}),
    },
  },
  timeout_ms: 30_000,
};

/**
 * Fetch MCP server configuration.
 *
 * Uses `mcp-server-fetch` (Python package, stdio transport via uvx).
 * No API key required — fetches public URLs.
 *
 * Tools provided:
 * - `fetch` — Fetch a URL and return its content as markdown
 *
 * Requires `uvx` (from the `uv` Python package manager) to be installed.
 *
 * @see https://github.com/modelcontextprotocol/servers/tree/main/src/fetch
 */
export const FETCH_SERVER: MCPServerEntry = {
  id: 'fetch',
  name: 'Web Fetch',
  description: 'Fetch URLs and extract content as markdown. No API key required. Requires uvx.',
  transport: {
    type: 'stdio',
    command: 'uvx',
    args: ['mcp-server-fetch'],
  },
  timeout_ms: 30_000,
};

// ─── All Default Servers ────────────────────────────────────────────

/**
 * All default MCP server configurations.
 *
 * Use {@link registerDefaultMCPServers} to register them into a registry,
 * or access individual entries (e.g., {@link WEB_SEARCH_SERVER}) for
 * selective registration.
 */
export const DEFAULT_MCP_SERVERS: readonly MCPServerEntry[] = [
  WEB_SEARCH_SERVER,
  FETCH_SERVER,
];

// ─── Registration Helper ────────────────────────────────────────────

/** Options for {@link registerDefaultMCPServers}. */
export interface RegisterDefaultMCPServersOptions {
  /**
   * Which default servers to register. Omit to register all.
   * Values are server IDs: `'web-search'`, `'fetch'`.
   */
  only?: string[];

  /**
   * Server IDs to skip. Applied after `only`.
   */
  exclude?: string[];

  /**
   * Override `allowedAgents` for all registered servers.
   * By default, servers are unrestricted (all agents can use them).
   */
  allowedAgents?: string[];

  /**
   * Override the `BRAVE_API_KEY` for the web-search server.
   * If not set, falls back to `process.env.BRAVE_API_KEY`.
   */
  braveApiKey?: string;
}

/**
 * Register default MCP server configurations into a registry.
 *
 * Registers pre-configured entries for common capabilities (web search,
 * URL fetching). Servers use stdio transport — web-search via `npx`
 * (npm) and fetch via `uvx` (Python). Packages are resolved on-the-fly.
 *
 * @param registry - The MCP server registry to register into.
 * @param options - Optional filtering and configuration overrides.
 * @returns Array of server IDs that were registered.
 *
 * @example
 * ```typescript
 * const mcpRegistry = new InMemoryMCPServerRegistry();
 *
 * // Register all defaults
 * registerDefaultMCPServers(mcpRegistry);
 *
 * // Register only web-search with a specific API key
 * registerDefaultMCPServers(mcpRegistry, {
 *   only: ['web-search'],
 *   brave_api_key: 'BSA-...',
 * });
 *
 * // Register all except web-search (fetch only)
 * registerDefaultMCPServers(mcpRegistry, {
 *   exclude: ['web-search'],
 * });
 * ```
 */
export async function registerDefaultMCPServers(
  registry: MCPServerRegistry,
  options?: RegisterDefaultMCPServersOptions,
): Promise<string[]> {
  const { only, exclude, allowedAgents, braveApiKey } = options ?? {};
  const registered: string[] = [];

  for (const server of DEFAULT_MCP_SERVERS) {
    // Filter by `only`
    if (only && !only.includes(server.id)) continue;
    // Filter by `exclude`
    if (exclude?.includes(server.id)) continue;

    // Apply overrides
    let entry = { ...server };

    if (allowedAgents) {
      entry = { ...entry, allowed_agents: allowedAgents };
    }

    // Apply braveApiKey override for web-search
    if (server.id === 'web-search' && entry.transport.type === 'stdio') {
      const apiKey = braveApiKey ?? process.env.BRAVE_API_KEY;
      if (apiKey) {
        entry = {
          ...entry,
          transport: {
            ...entry.transport,
            env: { ...entry.transport.env, BRAVE_API_KEY: apiKey },
          },
        };
      }
    }

    // The bundled defaults are snake_case wire-format constants; saveServer's
    // authoring type is camelCase but its runtime remap is idempotent on snake.
    await registry.saveServer(entry as unknown as MCPServerConfig);
    registered.push(entry.id);
  }

  return registered;
}
