/**
 * Context Compressor Type
 *
 * Narrow adapter interface for optional context compression in prompts.
 * The orchestrator owns this type; `@cycgraph/context-engine` is one implementation.
 *
 * Follows the `ModelResolver` pattern: a pure function type configured on
 * `GraphRunnerOptions`, injected through `NodeExecutorContext`, used in
 * prompt builders with graceful fallback when absent.
 *
 * @module agent/context-compressor
 */

/** Per-stage compression metrics. */
export interface ContextCompressionStageMetrics {
  /** Stage name. */
  name: string;
  /** Tokens before this stage. */
  tokensIn: number;
  /** Tokens after this stage. */
  tokensOut: number;
  /** Wall-clock time in milliseconds. */
  durationMs: number;
}

/** Aggregated compression metrics. */
export interface ContextCompressionMetrics {
  /** Total tokens in the original input. */
  totalTokensIn: number;
  /** Total tokens in the compressed output. */
  totalTokensOut: number;
  /** Reduction as a percentage (e.g. 35.2 = 35.2% reduction). */
  reductionPercent: number;
  /** Total compression wall-clock time in milliseconds. */
  totalDurationMs: number;
  /** Per-stage breakdown. */
  stages: ContextCompressionStageMetrics[];
}

/** Result of compressing serialized memory for a prompt. */
export interface ContextCompressionResult {
  /** The compressed memory string (replaces JSON.stringify output). */
  compressed: string;
  /** Compression metrics for observability. */
  metrics: ContextCompressionMetrics;
}

/**
 * Pure function that compresses sanitized memory data for prompt injection.
 *
 * Called in `buildSystemPrompt()` and `buildSupervisorSystemPrompt()` when
 * configured on `GraphRunnerOptions.contextCompressor`. Falls back to
 * `JSON.stringify(data, null, 2)` + byte-cap when absent.
 *
 * The function receives memory AFTER `sanitizeForPrompt()` has run —
 * security boundaries are preserved regardless of compression.
 *
 * Return `null` to explicitly fall back to default serialization.
 *
 * @param sanitizedMemory - Memory object after sanitization.
 * @param options - Contextual hints for compression.
 * @returns Compressed string + metrics, or `null` for default fallback.
 */
export type ContextCompressor = (
  sanitizedMemory: Record<string, unknown>,
  options?: {
    /** Model identifier for model-aware token counting. */
    model?: string;
    /** Max token budget for the memory section. */
    maxTokens?: number;
    /**
     * The task this context will be used for — the SANITIZED workflow
     * goal. Enables query-aware compression: the context engine's
     * relevance allocation concentrates budget on goal-relevant memory
     * (measured: retains 82% vs 57% of downstream-answerable content at
     * 3.6x compression). Implementations may ignore it.
     */
    query?: string;
  },
) => ContextCompressionResult | null;
