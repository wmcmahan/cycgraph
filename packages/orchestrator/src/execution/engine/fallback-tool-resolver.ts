/**
 * Fallback Tool Resolver
 *
 * Lightweight tool resolver used when `GraphRunnerOptions.tools` is absent
 * entirely. Resolves built-in tools from the shared catalog, warns when MCP
 * or custom sources are encountered (they can't be fulfilled without a
 * registration), and returns an echo proxy so unknown tool names still
 * produce something callable in test/dev environments.
 *
 * Production deployments should configure `GraphRunnerOptions.tools` — this
 * exists so examples and tests can run without tool infrastructure. The
 * echo proxy never engages once `tools` is configured: the composed
 * resolution fails fast on unregistered names instead of masking them.
 *
 * @module execution/engine/fallback-tool-resolver
 */

import type { ToolSource } from '../../tools/schema.js';
import { resolveBuiltinTools } from '../../tools/builtin/index.js';
import { createLogger } from '../../observability/logger.js';

const logger = createLogger('runner.fallback-tool-resolver');

/**
 * Resolve a list of tool sources without any tool infrastructure.
 *
 * - `builtin` sources resolve from the shared catalog.
 * - `mcp` and `custom` sources are skipped with a warning.
 * - Unknown tool names returned via the proxy resolve to an echo tool whose
 *   `execute(args)` returns `args`. This keeps test fixtures green even when
 *   tool resolution isn't wired.
 */
export async function resolveBuiltinsOnly(
  sources: ToolSource[],
  _agentId?: string,
): Promise<Record<string, unknown>> {
  const tools: Record<string, unknown> = resolveBuiltinTools(
    sources.filter((s) => s.type === 'builtin'),
  );
  for (const source of sources) {
    if (source.type === 'mcp') {
      logger.warn('mcp_source_skipped_no_resolver', {
        server_id: source.server_id,
        hint: 'Add a ToolResolver (MCPConnectionManager) to GraphRunnerOptions.tools to resolve MCP tool sources',
      });
    } else if (source.type === 'custom') {
      logger.warn('custom_source_skipped_no_registration', {
        tool_name: source.name,
        hint: 'Add the defineTool() result to GraphRunnerOptions.tools to resolve custom tool sources',
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
