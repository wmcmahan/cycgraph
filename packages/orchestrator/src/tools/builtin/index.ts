/**
 * Built-in Tool Catalog
 *
 * The single source of truth for tools the engine ships itself. Built-ins
 * are pure and dependency-free: no network, no filesystem, no subprocess.
 * Anything that touches the outside world belongs in a host-registered
 * `defineTool()` tool or an MCP server.
 *
 * Definitions are raw tool objects (`description` + `parameters` JSON schema
 * + `execute`) — NOT pre-formed AI SDK tools. The agent executor's
 * `buildToolSet()` wraps them with `tool()` + `jsonSchema()`; using
 * `inputSchema` here would falsely classify them as pre-formed and skip
 * that wrapping.
 *
 * The architect tool names (`architect_*`) are declarative placeholders:
 * they resolve to nothing here because their implementations need host
 * dependencies (persistence, publish gates) and are wired out-of-band via
 * `initArchitectTools()` + `executeArchitectTool()`.
 *
 * @module tools/builtin
 */

import type { BuiltinToolSource } from '../../tools/schema.js';

/**
 * Raw definition for the `save_to_memory` built-in. The actual persistence
 * is handled by the reducer (the executor routes the captured key/value
 * through the write-grant validation) — the tool just captures the pair
 * from the LLM.
 */
const SAVE_TO_MEMORY_DEF = {
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

/**
 * Resolve a single built-in tool name to its raw definition record, or
 * `null` for names that are declared but wired out-of-band (architect
 * tools) — matching the historical `createBuiltinTool` contract.
 */
export function resolveBuiltinTool(name: BuiltinToolSource['name']): Record<string, unknown> | null {
  switch (name) {
    case 'save_to_memory':
      return { save_to_memory: { ...SAVE_TO_MEMORY_DEF } };
    case 'architect_draft_workflow':
    case 'architect_publish_workflow':
    case 'architect_get_workflow':
      return null;
  }
}

/**
 * Resolve an array of built-in sources into a merged raw-definition record.
 * Unresolvable names (architect placeholders) are simply omitted.
 */
export function resolveBuiltinTools(sources: BuiltinToolSource[]): Record<string, unknown> {
  const tools: Record<string, unknown> = {};
  for (const source of sources) {
    const resolved = resolveBuiltinTool(source.name);
    if (resolved) Object.assign(tools, resolved);
  }
  return tools;
}
