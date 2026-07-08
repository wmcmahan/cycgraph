/**
 * MCP Error Classes
 *
 * Typed errors for the MCP connection manager and tool resolution subsystem.
 *
 * @module mcp/errors
 */

import { CycgraphError } from '../errors.js';

/**
 * Thrown when a tool source references an MCP server ID not found in the registry.
 *
 * @example
 * ```ts
 * throw new MCPServerNotFoundError('my-server');
 * ```
 */
export class MCPServerNotFoundError extends CycgraphError {
  constructor(
    /** The server ID that was not found. */
    public readonly serverId: string,
  ) {
    super(`MCP server not found in registry: "${serverId}"`);
    this.name = 'MCPServerNotFoundError';
  }
}

/**
 * Thrown when an agent is not authorized to use an MCP server.
 *
 * @example
 * ```ts
 * throw new MCPAccessDeniedError('agent-123', 'web-search');
 * ```
 */
export class MCPAccessDeniedError extends CycgraphError {
  constructor(
    /** The agent ID that was denied access. */
    public readonly agentId: string,
    /** The server ID the agent tried to access. */
    public readonly serverId: string,
  ) {
    super(`Agent "${agentId}" is not authorized to use MCP server "${serverId}"`);
    this.name = 'MCPAccessDeniedError';
  }
}

/**
 * Thrown when a per-tool circuit breaker is open and refusing execution.
 *
 * A tool's breaker opens after `failure_threshold` consecutive failures and
 * stays open for `cooldown_ms`. After the cooldown the next call enters
 * `half_open` — a single probe is allowed, success closes the breaker,
 * failure re-opens it.
 *
 * @example
 * ```ts
 * try {
 *   await tool.execute(args);
 * } catch (err) {
 *   if (err instanceof ToolCircuitBreakerOpenError) {
 *     // Tool is unhealthy — pick a fallback or skip this call
 *   }
 * }
 * ```
 */
export class ToolCircuitBreakerOpenError extends CycgraphError {
  constructor(
    /** The MCP server hosting the tool. */
    public readonly serverId: string,
    /** The tool name (un-namespaced — same as in `tools()` output). */
    public readonly toolName: string,
    /** Wall-clock ms remaining before the breaker transitions to half-open. */
    public readonly retryAfterMs: number,
  ) {
    super(
      `Circuit breaker open for MCP tool "${toolName}" on server "${serverId}". ` +
      `Retry after ${retryAfterMs}ms.`,
    );
    this.name = 'ToolCircuitBreakerOpenError';
  }
}
