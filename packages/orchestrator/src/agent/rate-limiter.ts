/**
 * Rate Limiter Port
 *
 * Optional injection seam (same ports-and-adapters pattern as
 * `ContextCompressor` / `MemoryRetriever` / `FitnessFunction`): the engine
 * defines the type, the host provides the implementation. When wired via
 * `GraphRunnerOptions.rateLimiter`, the runner awaits it immediately before
 * every LLM call (agent, supervisor, and evaluator) so a workflow can be paced
 * to stay inside a provider's request/throughput budget.
 *
 * The implementation may **delay** (resolve late — e.g. a token-bucket throttle
 * that waits for a permit) or **reject** (throw — e.g. a hard ceiling reached).
 * A throw surfaces as the node's execution error and follows the node's
 * `failure_policy`. The call is abortable via `options.abortSignal` so a
 * cancelled run doesn't hang waiting on a permit.
 *
 * @module agent/rate-limiter
 */

/** Which kind of LLM call is about to be issued. */
export type RateLimitCallKind = 'agent' | 'supervisor' | 'evaluator';

/** Context for a single rate-limit decision. */
export interface RateLimitRequest {
  /** The agent configuration id issuing the call. */
  agentId: string;
  /** The graph node the call originates from, when known. */
  nodeId?: string;
  /** The kind of executor making the call. */
  kind: RateLimitCallKind;
}

/**
 * Rate-limiting hook. Awaited before each LLM call. Resolve to admit the call
 * (optionally after a delay); throw to reject it.
 */
export type RateLimiter = (
  request: RateLimitRequest,
  options?: { abortSignal?: AbortSignal },
) => Promise<void>;
