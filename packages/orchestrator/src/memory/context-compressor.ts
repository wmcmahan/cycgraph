/**
 * Context Compressor Type
 *
 * Narrow adapter interface for optional context compression in prompts.
 * The orchestrator owns this type; `@cycgraph/context-engine` is one
 * implementation. Configured on `GraphRunnerOptions.contextCompressor`;
 * absent means every segment keeps its default serialization.
 *
 * @module memory/context-compressor
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

/**
 * Semantic role of a prompt segment. Mirrors the vocabulary compression
 * implementations use to decide how hard a segment may be squeezed.
 */
export type PromptSegmentRole = 'system' | 'memory' | 'history' | 'user' | 'custom';

/** One addressable piece of the prompt handed to a compressor. */
export interface PromptSegmentInput {
  /**
   * Stable identity. The same logical section carries the same id on every
   * call, so implementations can cache across turns and the builder can
   * match results back to sections.
   */
  id: string;
  /** The text to compress. */
  content: string;
  /** What this segment is, for role-aware strategies. */
  role: PromptSegmentRole;
  /** Relative importance. Higher keeps more budget under contention. */
  priority?: number;
  /**
   * The content must be returned byte-identical. Set on instructions and
   * the goal, where a rewrite would change what the agent was told to do.
   * Enforced: the builder discards a result that modifies a locked segment.
   */
  locked?: boolean;
}

/** Result of compressing a prompt's segments. */
export interface ContextCompressionResult {
  /**
   * The compressed segments, matched back by `id`. A segment the
   * implementation chooses not to return keeps its original content.
   */
  segments: Array<{ id: string; content: string }>;
  /** Compression metrics for observability. */
  metrics: ContextCompressionMetrics;
}

/**
 * Pure function that compresses a prompt's variable-size segments.
 *
 * Segments arrive sanitized and everything returned is re-sanitized: a
 * compressor is third-party code and its output is untrusted. Injection
 * boundary markers (`<data>` tags, DATA ONLY warnings) are emitted around
 * segments rather than inside them, so no stage can strip a guard.
 *
 * Return `null` to fall back to default serialization for every segment.
 *
 * @param segments - The prompt's compressible sections, plus locked ones
 *   for budget accounting.
 * @param options - Contextual hints for compression.
 * @returns Compressed segments + metrics, or `null` for default fallback.
 */
export type ContextCompressor = (
  segments: PromptSegmentInput[],
  options?: {
    /** Model identifier for model-aware token counting. */
    model?: string;
    /**
     * Token budget for the whole prompt. Usually absent — the orchestrator
     * does not track model context windows, so implementations should
     * derive a ceiling from `model`.
     */
    maxTokens?: number;
    /**
     * Tokens the agent may generate, from its `maxOutputTokens`. Prompt
     * plus generation must fit the context window, so the input budget is
     * the window minus this. Absent means no cap was set; treat it as
     * unknown, not zero.
     */
    outputReserve?: number;
    /**
     * The sanitized workflow goal, enabling query-aware compression:
     * budget concentrates on goal-relevant content. Implementations may
     * ignore it.
     */
    query?: string;
  },
) => ContextCompressionResult | null;
