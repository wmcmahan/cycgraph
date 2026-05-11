/**
 * Fallback Tool Resolver
 *
 * Lightweight tool resolver used when no `ToolResolver` (typically an
 * `MCPConnectionManager`) is configured on a runner. Resolves built-in tools
 * (currently just `save_to_memory`), warns when MCP sources are encountered
 * (since they can't be fulfilled without a real resolver), and returns an
 * echo proxy so unknown tool names still produce something callable in
 * test/dev environments.
 *
 * Production deployments should configure a real `ToolResolver` — this exists
 * so examples and tests can run without MCP infrastructure.
 *
 * @module runner/fallback-tool-resolver
 */

import type { ToolSource } from '../types/tools.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('runner.fallback-tool-resolver');

/**
 * Resolve a list of tool sources without any MCP infrastructure.
 *
 * - `builtin: save_to_memory` is resolved to its standard description+execute.
 * - `mcp: *` sources are skipped with a warning.
 * - Unknown tool names returned via the proxy resolve to an echo tool whose
 *   `execute(args)` returns `args`. This keeps test fixtures green even when
 *   tool resolution isn't wired.
 */
export async function resolveBuiltinsOnly(
  sources: ToolSource[],
  _agentId?: string,
): Promise<Record<string, unknown>> {
  const tools: Record<string, unknown> = {};
  for (const source of sources) {
    if (source.type === 'builtin' && source.name === 'save_to_memory') {
      tools.save_to_memory = {
        description: 'Save data to workflow memory for later use',
        parameters: {
          type: 'object',
          properties: {
            key: { type: 'string', description: 'Memory key to store the value under' },
            value: { description: 'Value to save (can be any type)' },
          },
          required: ['key', 'value'],
        },
        execute: async (args: Record<string, unknown>) => {
          return { key: args.key, value: args.value, saved: true };
        },
      };
    } else if (source.type === 'mcp') {
      logger.warn('mcp_source_skipped_no_resolver', {
        server_id: source.server_id,
        hint: 'Configure a ToolResolver (MCPConnectionManager) to resolve MCP tool sources',
      });
    }
  }

  // Echo proxy: unknown tool names return a benign passthrough so test/dev
  // setups don't crash on unconfigured tools.
  return new Proxy(tools, {
    get(target, prop) {
      if (typeof prop === 'string' && prop in target) return target[prop];
      if (typeof prop === 'string') {
        return {
          description: `Echo tool: ${prop} (no ToolResolver configured)`,
          parameters: {},
          execute: async (args: Record<string, unknown>) => args,
        };
      }
      return undefined;
    },
  });
}
