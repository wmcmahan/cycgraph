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
import { ToolSourceSchema } from '../types/tools.js';
import { ModelTierSchema } from './model-resolver.js';

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
  /** Sampling temperature (0 = deterministic, 1 = creative). */
  temperature: z.number().min(0).max(1).default(0.7),
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

  /** Structured tool source declarations. References built-in tools and registered MCP servers by ID. */
  tools: z.array(ToolSourceSchema).default([]),

  // ── Zero Trust Permissions (deny-all by default) ──

  /** Memory keys the agent may read. `['*']` = wildcard. */
  read_keys: z.array(z.string()).default([]),
  /** Memory keys the agent may write. `['*']` = wildcard. */
  write_keys: z.array(z.string()).default([]),
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
