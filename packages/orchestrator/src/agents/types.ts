/**
 * Agent Type Definitions
 *
 * Defines the Zod schema and inferred type for agent configurations.
 * Agents are pure config records (not classes) — the factory loads them,
 * the executor consumes them.
 *
 * Security: Both `read_keys` and `write_keys` default to `[]` (deny-all).
 * Permissions must be explicitly granted in the agent registry.
 *
 * @module agent/types
 */

import { z } from 'zod';
import type { JSONValue } from 'ai';
import { ToolSourceInputSchema } from '../tools/schema.js';
import { ModelTierSchema } from './models/model-resolver.js';

/**
 * Recursive Zod schema for JSON-safe values.
 *
 * Matches the AI SDK's `JSONValue` type so that `providerOptions`
 * can be passed directly to `streamText` / `generateText` without
 * type narrowing.
 */
const jsonValueSchema: z.ZodType<JSONValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

/** Zod schema for a JSON object (matches AI SDK's `JSONObject`). */
const jsonObjectSchema = z.record(z.string(), jsonValueSchema);

/**
 * Zod schema for agent configuration records.
 *
 * Validated by the {@link AgentFactory} on every load via `AgentConfigSchema.parse()`.
 * Defaults are applied when fields are missing from the registry entry.
 */
export const AgentConfigSchema = z.object({
  /** Unique agent identifier (typically a UUID from the registry). */
  id: z.string(),
  /** Human-readable agent name. */
  name: z.string(),
  /** Optional description of the agent's purpose. */
  description: z.string().optional(),

  // ── AI SDK Core Properties ──

  /** Model identifier (e.g. `'claude-sonnet-4-6'`, `'gpt-4-turbo'`). */
  model: z.string(),
  /** LLM provider — determines which AI SDK factory is used. */
  provider: z.string(),
  /** System prompt — defines the agent's behaviour and constraints. */
  system: z.string(),
  /**
   * Sampling temperature (0 = deterministic). Range 0–2 to match the widest
   * provider surface (OpenAI, Ollama); Anthropic caps at 1 and a higher value
   * is rejected by the cross-field check below rather than erroring mid-run
   * at the API.
   */
  temperature: z.number().min(0).max(2).default(0.7),
  /** Maximum tool-call steps before the agent is forced to stop. */
  maxSteps: z.number().min(1).max(50).default(10),

  /**
   * Provider-specific options, namespaced by provider name.
   *
   * Passed through directly to the LLM call (e.g. `streamText`).
   * Allows configuring provider-native features without coupling
   * the schema to any specific provider SDK.
   *
   * @example
   * ```json
   * {
   *   "anthropic": {
   *     "thinking": { "type": "enabled", "budgetTokens": 12000 }
   *   }
   * }
   * ```
   */
  providerOptions: z.record(z.string(), jsonObjectSchema).optional(),

  // ── Budget-Aware Model Resolution ──

  /**
   * Capability tier preference for budget-aware model resolution.
   *
   * When set (and a {@link ModelResolver} is configured on the runner),
   * the engine resolves to a concrete model at runtime based on
   * remaining budget. When absent, `model` is used directly.
   */
  model_preference: ModelTierSchema.optional(),

  // ── Capabilities ──

  /** Structured tool source declarations. References built-in tools, host-registered custom tools, and registered MCP servers by ID. Accepts authoring sugar (bare names, `{ mcp: id }`); always parses to the structured wire form. */
  tools: z.array(ToolSourceInputSchema).default([]),

  // ── Permission CEILING (optional — ADR 001) ──
  //
  // The graph NODE's read_keys/write_keys are the authoritative grant; these
  // fields, when present, are a hard cap intersected with the grant ("this
  // agent may never touch more than X, anywhere"). `undefined` = uncapped.
  // An EXPLICIT empty array still means deny-all.

  /** Memory-key read ceiling. `['*']` = uncapped; `undefined` = uncapped. */
  read_keys: z.array(z.string()).optional(),
  /** Memory-key write ceiling. `['*']` = uncapped; `undefined` = uncapped. */
  write_keys: z.array(z.string()).optional(),
}).superRefine((config, ctx) => {
  // Anthropic's API rejects temperature > 1 — fail at config validation, not
  // mid-run at the provider.
  if (config.provider === 'anthropic' && config.temperature > 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['temperature'],
      message: `temperature ${config.temperature} exceeds Anthropic's maximum of 1`,
    });
  }
});

/** Inferred TypeScript type for a validated agent config. */
export type AgentConfig = z.infer<typeof AgentConfigSchema>;

/**
 * Metadata attached to every agent execution action.
 *
 * Captured by the executor and stored on the `Action.metadata` field
 * for observability, debugging, and cost tracking.
 */
export interface AgentExecutionMetadata {
  /** ID of the agent that was executed. */
  agent_id: string;
  /** Graph node that triggered the execution. */
  node_id: string;
  /** Retry attempt number (1-based). */
  attempt: number;
  /** When the execution completed. */
  timestamp: Date;
  /** Wall-clock duration in milliseconds. */
  duration_ms: number;
  /** LLM finish reason (e.g. `'stop'`, `'length'`, `'tool-calls'`). */
  finish_reason?: string;
  /** Names of tools invoked during execution. */
  tool_calls: string[];
  /** Token usage breakdown for cost tracking. */
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  /** Model resolution info when budget-aware resolution was applied. */
  model_resolution?: {
    /** The agent's static fallback model. */
    original_model: string;
    /** The model actually used after resolution. */
    resolved_model: string;
  };
}
