/**
 * Custom error classes for the agent executor subsystem.
 *
 * Each class sets `this.name` to its own class name so error handlers can
 * reliably `switch` on `error.name` without `instanceof` checks across
 * module boundaries.
 *
 * @module agent-executor/errors
 */

import { CycgraphError } from '../../errors.js';

/**
 * Thrown when an agent attempts to write to a memory key it does not
 * have permission for, as defined by the agent's `write_keys` config.
 *
 * @example
 * ```ts
 * throw new PermissionDeniedError(
 *   'Agent attempted to write to unauthorized keys: secret_key'
 * );
 * ```
 */
export class PermissionDeniedError extends CycgraphError {
  constructor(message: string) {
    super(message);
    this.name = 'PermissionDeniedError';
  }
}

/**
 * Thrown when an agent's LLM call exceeds its configured timeout.
 *
 * The executor wraps the `streamText` call with an `AbortController`
 * and converts the resulting `AbortError` into this typed error.
 *
 * @example
 * ```ts
 * throw new AgentTimeoutError('agent-123', 120_000);
 * // → "Agent agent-123 timed out after 120000ms"
 * ```
 */
/** Token usage observed before an agent call failed (best-effort, may be partial). */
export interface PartialUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  model?: string;
}

export class AgentTimeoutError extends CycgraphError {
  /** Tokens spent before the timeout, if the provider surfaced them. */
  readonly partialUsage?: PartialUsage;
  constructor(agent_id: string, timeout_ms: number, partialUsage?: PartialUsage) {
    super(`Agent ${agent_id} timed out after ${timeout_ms}ms`);
    this.name = 'AgentTimeoutError';
    this.partialUsage = partialUsage;
  }
}

/**
 * Thrown when an agent's LLM call fails for any non-timeout reason
 * (API errors, rate limits, network failures, etc.).
 *
 * The original error is preserved via the native ES2022 `cause` property.
 *
 * @example
 * ```ts
 * throw new AgentExecutionError('agent-456', originalError);
 * // → "Agent agent-456 execution failed: API rate limited"
 * // access original via error.cause
 * ```
 */
export class AgentExecutionError extends CycgraphError {
  /** Tokens spent before the failure, if the provider surfaced them. */
  readonly partialUsage?: PartialUsage;
  /**
   * Whether retrying could plausibly succeed. `false` for deterministic
   * failures (400 invalid-request, context-length-exceeded, 401/403/404) so
   * the runner doesn't waste `max_retries` full LLM calls re-issuing a
   * request that will fail identically. `true`/`undefined` for transient
   * failures (429 rate-limit, 5xx, 529 overloaded, network).
   */
  readonly retryable?: boolean;
  constructor(agent_id: string, cause: unknown, partialUsage?: PartialUsage, retryable?: boolean) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(`Agent ${agent_id} execution failed: ${message}`, { cause });
    this.name = 'AgentExecutionError';
    this.partialUsage = partialUsage;
    this.retryable = retryable;
  }
}
