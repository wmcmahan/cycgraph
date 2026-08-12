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
   * When true the content must be returned byte-identical. Instructions and
   * the goal are locked: rewriting them changes what the agent was told to
   * do. The builder REJECTS a result that modifies a locked segment and
   * falls back, so this is enforced rather than trusted.
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
 * Called in `buildSystemPrompt()` and `buildSupervisorSystemPrompt()` when
 * configured on `GraphRunnerOptions.contextCompressor`. When absent, every
 * segment keeps its default serialization and byte cap.
 *
 * Every segment arrives AFTER sanitization, and everything returned is
 * re-sanitized before it reaches the prompt. A compressor is third-party
 * code and its output is treated as untrusted.
 *
 * Prompt-injection boundary markers are NOT part of any segment. The
 * builder emits `<data>` tags and DATA ONLY warnings as structure around
 * segments, so no compression stage can strip a guard.
 *
 * Return `null` to explicitly fall back to default serialization for every
 * segment.
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
     * Token budget for the whole prompt when the caller knows it.
     * Usually absent: the orchestrator does not track model context
     * windows, so an implementation should derive its own ceiling from
     * `model` rather than assume a number on the caller's behalf.
     */
    maxTokens?: number;
    /**
     * Tokens the agent is permitted to generate, from its
     * `maxOutputTokens`. A request must fit prompt plus generation inside
     * the context window, so the real input budget is the window minus
     * this.
     *
     * Absent means the agent set no cap and the provider will apply its
     * own, typically the model's maximum. An implementation that cares
     * about a true ceiling should treat absence as "reserve unknown" and
     * be conservative rather than assume zero.
     */
    outputReserve?: number;
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
