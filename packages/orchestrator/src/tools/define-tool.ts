/**
 * defineTool — schema-first custom tool definitions
 *
 * The host-facing helper for the custom tool layer. A defined tool is a
 * runtime object registered via `GraphRunnerOptions.tools`; graphs and agent
 * configs reference it by name (`{ type: 'custom', name }` on the wire, a
 * bare string in authoring sugar). The implementation is never serialized.
 *
 * The returned tool's `execute` is wrapped with:
 * - Zod validation of the LLM-supplied arguments (the real input gate — the
 *   AI SDK's JSON-schema carrier does not validate),
 * - a per-call timeout mirroring the MCP per-tool timeout.
 *
 * Thrown errors (including validation and timeout) propagate — the AI SDK
 * surfaces them to the LLM as normal tool-call failures rather than killing
 * the node.
 *
 * Taint is declared here (`taints: true` for tools that ingest external
 * data) but recorded at resolution time by the composed tool resolution,
 * which owns the per-execution collector.
 *
 * @module tools/define-tool
 */

import { z } from 'zod';
import { BUILTIN_TOOL_NAMES } from './schema.js';

/** Default per-call execution timeout — aligned with the MCP default. */
export const DEFAULT_CUSTOM_TOOL_TIMEOUT_MS = 30_000;

const TOOL_NAME_PATTERN = /^[a-z0-9_-]+$/i;

/** Thrown by {@link defineTool} for an invalid spec (bad name, builtin collision). */
export class ToolDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolDefinitionError';
  }
}

/** Input spec accepted by {@link defineTool}. */
export interface DefinedToolSpec<TArgs extends z.ZodType = z.ZodType> {
  /** Tool name referenced from graph/agent config. Alphanumeric, hyphens, underscores. */
  name: string;
  /** Description surfaced to the LLM. */
  description: string;
  /** Zod schema for the tool's arguments. Parsed on every call. */
  parameters: TArgs;
  /** The implementation. Receives parsed (schema-validated) arguments. */
  execute: (args: z.infer<TArgs>) => Promise<unknown> | unknown;
  /**
   * Whether results should be taint-tracked as external data.
   * Defaults to `false`: custom tools are first-party code. Set `true` for
   * tools that ingest external content (network fetches, user documents) so
   * their output lands in `state.taint_registry` like MCP tool output.
   */
  taints?: boolean;
  /** Per-call timeout in ms. `0` disables. @default 30000 */
  timeoutMs?: number;
}

/**
 * A validated, execution-ready custom tool. Register via
 * `GraphRunnerOptions.tools`. The `parameters` field is the JSON-schema
 * projection of the spec's Zod schema (what the LLM sees); validation runs
 * against the original Zod schema inside `execute`.
 */
export interface DefinedTool {
  readonly name: string;
  readonly description: string;
  readonly taints: boolean;
  readonly parameters: Record<string, unknown>;
  readonly execute: (args: unknown) => Promise<unknown>;
}

/**
 * Whether a value is a {@link DefinedTool}. Shape-based (a named object
 * carrying an `execute` function) rather than branded, so it also recognizes
 * tools that crossed a structural boundary — a deep clone, a case remap, or
 * a `@cycgraph/tools` factory result.
 */
export function isDefinedTool(value: unknown): value is DefinedTool {
  if (value === null || typeof value !== 'object') return false;
  const tool = value as Partial<DefinedTool>;
  return typeof tool.name === 'string' && typeof tool.execute === 'function';
}

/**
 * Race a tool invocation against its timeout. Mirrors the MCP connection
 * manager's per-tool timeout so custom and MCP tools fail the same way.
 */
async function invokeWithTimeout(
  run: () => Promise<unknown>,
  toolName: string,
  timeoutMs: number,
): Promise<unknown> {
  if (timeoutMs <= 0) return run();

  let timeoutId: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`Custom tool "${toolName}" timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Define a custom tool for registration on `GraphRunnerOptions.tools`.
 *
 * Validates the spec eagerly (invalid names and builtin collisions throw
 * here, at definition time, not mid-run) and returns a {@link DefinedTool}
 * whose `execute` parses arguments through the Zod schema and enforces the
 * per-call timeout.
 *
 * @throws {ToolDefinitionError} On an invalid name, a builtin-name
 *   collision, or a missing description.
 */
export function defineTool<TArgs extends z.ZodType>(spec: DefinedToolSpec<TArgs>): DefinedTool {
  if (!spec.name || !TOOL_NAME_PATTERN.test(spec.name)) {
    throw new ToolDefinitionError(
      `Invalid tool name "${spec.name}": must be non-empty alphanumeric, hyphens, or underscores`,
    );
  }
  if ((BUILTIN_TOOL_NAMES as readonly string[]).includes(spec.name)) {
    throw new ToolDefinitionError(
      `Tool name "${spec.name}" collides with a built-in tool name`,
    );
  }
  if (!spec.description) {
    throw new ToolDefinitionError(`Tool "${spec.name}" is missing a description`);
  }

  const timeoutMs = spec.timeoutMs ?? DEFAULT_CUSTOM_TOOL_TIMEOUT_MS;
  const parameters = z.toJSONSchema(spec.parameters) as Record<string, unknown>;

  return {
    name: spec.name,
    description: spec.description,
    taints: spec.taints ?? false,
    parameters,
    execute: async (args: unknown): Promise<unknown> => {
      const parsed = spec.parameters.parse(args);
      return invokeWithTimeout(() => Promise.resolve(spec.execute(parsed)), spec.name, timeoutMs);
    },
  };
}

/** Terse alias of {@link defineTool} */
export const tool = defineTool;
