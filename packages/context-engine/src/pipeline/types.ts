/**
 * Pipeline Types
 *
 * Core type definitions for the composable compression pipeline.
 * All configuration types are Zod-validated at the pipeline boundary.
 *
 * @module pipeline/types
 */

import { z } from 'zod';
import type { TokenCounter } from '../providers/types.js';

// --- Zod Schemas ---

export const SegmentRoleSchema = z.enum([
  'system',
  'memory',
  'tools',
  'history',
  'user',
  'custom',
]);

export const PromptSegmentSchema = z.object({
  /** Unique identifier for this segment. */
  id: z.string(),
  /** The text content of this segment. */
  content: z.string(),
  /** Semantic role of this segment in the prompt. */
  role: SegmentRoleSchema,
  /** Priority weight (higher = more important, gets more budget). */
  priority: z.number().min(0).default(1),
  /** If true, this segment bypasses all compression stages. */
  locked: z.boolean().default(false),
  /** Arbitrary metadata (passed through stages unchanged). */
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const BudgetConfigSchema = z.object({
  /** Maximum total tokens for the compressed output. */
  maxTokens: z.number().int().positive(),
  /** Tokens reserved for model output generation. */
  outputReserve: z.number().int().min(0).default(0),
  /** Per-segment budget overrides (segment id → max tokens). */
  segmentBudgets: z.record(z.string(), z.number().int().positive()).optional(),
});

// --- Inferred Types ---

export type SegmentRole = z.infer<typeof SegmentRoleSchema>;
/**
 * User-facing prompt segment shape.
 *
 * Uses `z.input` so fields with Zod defaults (`priority`, `locked`) are
 * optional at the call site. The pipeline parses through the schema
 * internally, where defaults are filled in.
 */
export type PromptSegment = z.input<typeof PromptSegmentSchema>;
/** Fully-parsed segment with all defaults applied. */
export type ParsedPromptSegment = z.infer<typeof PromptSegmentSchema>;
/**
 * User-facing budget config.
 *
 * Uses `z.input` so `outputReserve` (which has a Zod default) is optional.
 */
export type BudgetConfig = z.input<typeof BudgetConfigSchema>;
/** Fully-parsed budget with all defaults applied. */
export type ParsedBudgetConfig = z.infer<typeof BudgetConfigSchema>;

// --- Logger ---

/** Optional logger for pipeline diagnostic output. */
export interface PipelineLogger {
  debug?(message: string): void;
  warn?(message: string): void;
}

/** No-op logger (default when none provided). */
export const noopLogger: PipelineLogger = {};

// --- Non-Schema Types ---

/** Per-stage compression metrics. */
export interface StageMetrics {
  /** Stage name. */
  name: string;
  /** Tokens before this stage ran. */
  tokensIn: number;
  /** Tokens after this stage ran. */
  tokensOut: number;
  /** Compression ratio (tokensOut / tokensIn). 1.0 = no change. */
  ratio: number;
  /** Wall-clock time for this stage in milliseconds. */
  durationMs: number;
  /** Whether the stage encountered an error and passed through. */
  error?: boolean;
}

/** Aggregated pipeline metrics across all stages. */
export interface PipelineMetrics {
  /** Total tokens in the original input. */
  totalTokensIn: number;
  /** Total tokens in the compressed output. */
  totalTokensOut: number;
  /** Overall compression ratio. */
  overallRatio: number;
  /** Total reduction as a percentage (e.g. 45.2 = 45.2% reduction). */
  reductionPercent: number;
  /** Total pipeline wall-clock time in milliseconds. */
  totalDurationMs: number;
  /** Per-stage breakdown. */
  stages: StageMetrics[];
  /** True when all segments were served from cache (no compression ran this turn). */
  cached?: boolean;
}

/** Context available to each compression stage. */
export interface StageContext {
  /** Token counter for measuring compression. */
  tokenCounter: TokenCounter;
  /**
   * Budget configuration. `maxTokens` is the share available to the segments
   * the stage sees — the pipeline subtracts locked segments' tokens before
   * building this context.
   */
  budget: BudgetConfig;
  /** Target model (for model-aware compression). */
  model?: string;
  /** Whether debug mode is enabled (source maps, extra logging). */
  debug?: boolean;
  /**
   * The pipeline's logger. Stages should emit diagnostics through this
   * (falling back to console for must-see warnings when it's absent or no-op).
   */
  logger?: PipelineLogger;
}

/** Result returned by a single compression stage. */
export interface StageResult {
  /** The segments after compression. */
  segments: PromptSegment[];
  /** Metrics for this stage (computed by the pipeline, not the stage). */
  metrics?: StageMetrics;
}

/** A single composable compression stage. */
export interface CompressionStage {
  /** Human-readable stage name (used in metrics). */
  readonly name: string;
  /**
   * Whether this stage operates per-segment or across segments.
   *
   * Default when omitted: 'cross-segment' — the safe assumption; the
   * incremental pipeline re-runs the stage on ALL segments whenever anything
   * changes. Declare 'per-segment' ONLY if each segment's output depends
   * solely on that segment's own content — this opts the stage into
   * per-segment caching. A stage with any state spanning segments (a `seen`
   * set, budget shares, corpus statistics) must not declare it.
   */
  readonly scope?: 'per-segment' | 'cross-segment';
  /** Execute the compression stage on the given segments. */
  execute(segments: PromptSegment[], context: StageContext): StageResult;
}

/** Configuration for creating a pipeline. */
export interface PipelineConfig {
  /** Ordered list of compression stages. */
  stages: CompressionStage[];
  /** Custom token counter (defaults to model-family estimator). */
  tokenCounter?: TokenCounter;
  /** Enable debug mode (source maps, extra metrics). */
  debug?: boolean;
  /** Optional logger for warnings and debug output (defaults to no-op). */
  logger?: PipelineLogger;
  /** Pipeline-level timeout in ms. Remaining stages are skipped if exceeded. */
  timeoutMs?: number;
}

/** Input to a pipeline compression call. */
export interface PipelineInput {
  /** The prompt segments to compress. */
  segments: PromptSegment[];
  /** Token budget for the output. */
  budget: BudgetConfig;
  /** Target model string (passed to token counter and format selector). */
  model?: string;
}

/**
 * Source map entry: maps a compressed segment back to its original.
 *
 * Provenance is segment-level, not token-level: `original`/`compressed` are
 * whole-content snapshots, and `changedBy` attributes changes to stages —
 * there is no intra-segment span mapping.
 */
export interface SourceMapEntry {
  segmentId: string;
  /** Content before the first stage ran. Empty string for stage-added segments. */
  original: string;
  /** Content after the last stage ran. Empty string for removed segments. */
  compressed: string;
  /** Names of stages that modified this segment's content, in execution order. */
  changedBy: string[];
  /** True when a stage removed this segment; it is absent from the pipeline output. */
  removed?: boolean;
  /** Name of the stage that removed this segment. */
  removedBy?: string;
  /** Name of the stage that introduced this segment (id not present in the input). */
  addedBy?: string;
  /**
   * True when part of this entry's provenance was computed on an earlier turn
   * and reused from cache (incremental pipeline only).
   */
  fromCache?: boolean;
}

/** Result returned by the pipeline. */
export interface PipelineResult {
  /** Compressed segments. */
  segments: PromptSegment[];
  /** Aggregated pipeline metrics. */
  metrics: PipelineMetrics;
  /** Debug source map (only populated when debug mode is enabled). */
  sourceMap?: SourceMapEntry[];
}
