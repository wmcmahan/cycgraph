/**
 * ToolResolver — the tool-resolution contract
 *
 * Resolves `ToolSource[]` declarations into an executable tool set.
 * Implemented by both the in-process `ComposedToolResolution` (this package)
 * and `MCPConnectionManager` (the MCP bridge). It lives here, in `tools/`,
 * so `tools/` and `mcp/` both depend on it without depending on each other.
 *
 * @module tools/resolver
 */

import type { ToolSource } from './schema.js';
import type { TaintMetadata } from '../state/state.js';

/** Resolves tool sources into an executable tool set. */
export interface ToolResolver {
  /**
   * Resolve an array of ToolSource declarations into a tool set.
   * Returns a merged record of tool name → tool object with execute functions.
   *
   * @param sources - Tool source declarations from the agent config.
   * @param agentId - The requesting agent's ID (for access control).
   */
  resolveTools(sources: ToolSource[], agentId?: string): Promise<Record<string, unknown>>;

  /**
   * Close all open MCP client connections and release resources.
   */
  closeAll(): Promise<void>;

  /**
   * Drain accumulated taint entries from MCP tool executions.
   *
   * Pass the exact toolset returned by a prior `resolveTools()` call to drain
   * ONLY that execution's taint — required for correctness under concurrent
   * executions (voting / evolution / map), where a single shared accumulator
   * would let one agent's drain swallow another's still-accumulating entries.
   * Called with no argument, falls back to a process-wide accumulator
   * (legacy / single-execution behavior).
   *
   * Optional — only implemented by MCPConnectionManager.
   */
  drainTaintEntries?(tools?: Record<string, unknown>): Map<string, TaintMetadata>;
}
