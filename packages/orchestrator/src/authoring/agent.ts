/**
 * Core agent authoring utilities.
 *
 * An agent value is a CAPABILITY only: model, instructions, tools, sampling.
 * It carries no topology — placement in a graph (node id, state grants) is
 * `node()`'s job — and no registry id: `graph()` mints one when it compiles,
 * and `run()` registers the config into a run-scoped registry.
 *
 * The pipeline: `agent()`/`node()` produce inert values, `graph()` compiles
 * them to the serializable wire Graph, `run()` executes it.
 *
 * @module authoring/agent
 */

import type { AgentRegistryConfig } from '../persistence/interfaces.js';
import type { ToolSourceInput } from '../types/tools.js';
import { isDefinedTool, type DefinedTool } from '../tools/define-tool.js';

/** Brand marking a value produced by {@link agent}. */
export const AGENT_BRAND: unique symbol = Symbol('cycgraph.authoring.agent');

/** What an agent IS — never where it runs. */
export interface AgentSpec {
  /** LLM model identifier (e.g. `'claude-sonnet-4-6'`). */
  model: string;
  /** System prompt. */
  instructions: string;
  /**
   * Pin the registry id. Omit (the default) and `graph()` mints a UUID —
   * ids are the registry's job. Pin only when you need deterministic graph
   * JSON (e.g. shareable graphs).
   */
  id?: string;
  /**
   * Human-readable name for registry listings and observability. Defaults to
   * the agent's id. Not used for routing: supervisors address managed NODES
   * by their node ids.
   */
  name?: string;
  /** Provider name. Inferred from the model prefix when omitted. */
  provider?: string;
  /**
   * Tools the agent may use: `tool()` values (auto-registered by `run()`),
   * bare names, `{ mcp }` server refs, or structured sources.
   */
  tools?: ToolSourceInput[];
  /** Sampling temperature (0–1). */
  temperature?: number;
  /** Maximum tool-call steps. */
  maxSteps?: number;
  /** Human-readable description, stored on the registry entry for humans and tooling. */
  description?: string;
  /** Capability-tier preference for budget-aware model resolution. */
  modelPreference?: AgentRegistryConfig['modelPreference'];
  /** Provider-specific options, namespaced by provider name. */
  providerOptions?: AgentRegistryConfig['providerOptions'];
}

/**
 * A reusable agent value. Reference it from `node({ agent })` or from any
 * `…agentId` config field; `graph()` resolves it to a registry id and
 * `run()` registers it. One value used in many places is registered once.
 */
export interface AgentValue {
  readonly [AGENT_BRAND]: true;
  readonly spec: AgentSpec;
  /** Registry id, minted lazily at first compile. @internal */
  resolvedId?: string;
}

/** Whether a value is an {@link AgentValue}. */
export function isAgentValue(value: unknown): value is AgentValue {
  return typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[AGENT_BRAND] === true;
}

/** Thrown for an invalid agent spec (e.g. an unresolvable provider). */
export class AgentSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentSpecError';
  }
}

/**
 * Infer the provider from a model name. Kept deliberately small — the
 * common frontier families only; anything else must name its provider.
 */
export function inferProvider(model: string): string | null {
  if (/^claude/i.test(model)) return 'anthropic';
  // gpt-oss is an open-weights family typically served via Ollama — inferring
  // 'openai' would route it to the wrong API. Force an explicit provider.
  if (/^gpt-oss/i.test(model)) return null;
  if (/^(gpt-|o[1-9]|chatgpt)/i.test(model)) return 'openai';
  return null;
}

/**
 * Define a reusable agent capability. The provider is inferred from the
 * model name when not given.
 *
 * @throws {AgentSpecError} When the provider can't be inferred and none is given.
 */
export function agent(spec: AgentSpec): AgentValue {
  const provider = spec.provider ?? inferProvider(spec.model);
  if (!provider) {
    throw new AgentSpecError(
      `Could not infer a provider from model "${spec.model}"; pass provider: '…' explicitly`,
    );
  }
  return { [AGENT_BRAND]: true, spec: { ...spec, provider } };
}

/**
 * The agent value's registry id, minting one on first use. Cached on the
 * value, so the same value keeps one id across nodes and graphs in-process.
 */
export function ensureAgentId(value: AgentValue): string {
  if (!value.resolvedId) {
    (value as { resolvedId?: string }).resolvedId = value.spec.id ?? crypto.randomUUID();
  }
  return value.resolvedId!;
}

/**
 * Build the registry config for an agent value (used by `run`'s registration).
 * `tool()` references in `spec.tools` collapse to their serializable
 * `{ type: 'custom', name }` source; pass `collectTool` to receive each
 * implementation (how `graph()` stashes agent-level inline tools for `run()`).
 */
export function toRegistryConfig(
  value: AgentValue,
  collectTool?: (tool: DefinedTool) => void,
): AgentRegistryConfig & { id: string } {
  const { spec } = value;
  const id = ensureAgentId(value);

  const tools = (spec.tools ?? []).map((entry) => {
    if (!isDefinedTool(entry)) {
      return entry;
    }
    collectTool?.(entry);
    return { type: 'custom' as const, name: entry.name };
  });

  return {
    id,
    name: spec.name ?? id,
    description: spec.description ?? null,
    model: spec.model,
    provider: spec.provider!,
    systemPrompt: spec.instructions,
    tools,
    permissions: null,
    ...(spec.temperature !== undefined ? { temperature: spec.temperature } : {}),
    ...(spec.maxSteps !== undefined ? { maxSteps: spec.maxSteps } : {}),
    ...(spec.modelPreference ? { modelPreference: spec.modelPreference } : {}),
    ...(spec.providerOptions ? { providerOptions: spec.providerOptions } : {}),
  } as AgentRegistryConfig & { id: string };
}
