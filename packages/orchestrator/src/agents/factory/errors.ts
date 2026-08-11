/**
 * Custom error classes for the agent factory subsystem.
 *
 * Each class sets `this.name` to its own class name so error handlers can
 * reliably `switch` on `error.name` without `instanceof` checks across
 * module boundaries.
 *
 * @module agent-factory/errors
 */

import { CycgraphError } from '../../errors.js';

/**
 * Thrown when an agent ID cannot be resolved — either the ID is not a valid
 * UUID or the registry returned `null`.
 *
 * Fails closed by default: the factory propagates this error so a typo'd or
 * deleted agent_id surfaces loudly. Only when `setAllowDefaultFallback(true)`
 * is set (tests / lightweight dev) does the factory catch it and fall back
 * to the deny-all default config.
 *
 * @example
 * ```ts
 * throw new AgentNotFoundError('invalid-id');
 * // → "Agent not found: invalid-id"
 * ```
 */
export class AgentNotFoundError extends CycgraphError {
  constructor(agent_id: string) {
    super(`Agent not found: ${agent_id}`);
    this.name = 'AgentNotFoundError';
  }
}

/**
 * Thrown when model resolution encounters a provider name that is not
 * registered in the {@link ProviderRegistry} (built-ins: `openai`,
 * `anthropic`; others register via `configureProviderRegistry` /
 * `registerOllamaProvider`).
 *
 * @example
 * ```ts
 * throw new UnsupportedProviderError('gemini');
 * // → "Unsupported provider: gemini"
 * ```
 */
export class UnsupportedProviderError extends CycgraphError {
  constructor(provider: string) {
    super(`Unsupported provider: ${provider}`);
    this.name = 'UnsupportedProviderError';
  }
}

/**
 * Thrown when agent loading fails due to a transient error (database
 * connection, network, schema mismatch, missing API key, etc.).
 *
 * The original error is preserved via the native ES2022 `cause` property.
 * Unlike {@link AgentNotFoundError}, this error is **not** caught by the
 * factory — it propagates to the caller to prevent silent data loss from
 * running agents with deny-all permissions.
 *
 * @example
 * ```ts
 * throw new AgentLoadError('agent-456', dbConnectionError);
 * // → "Failed to load agent agent-456: connection refused"
 * // access original via error.cause
 * ```
 */
export class AgentLoadError extends CycgraphError {
  constructor(agent_id: string, cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(`Failed to load agent ${agent_id}: ${message}`, { cause });
    this.name = 'AgentLoadError';
  }
}
