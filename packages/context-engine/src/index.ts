/**
 * @cycgraph/context-engine
 *
 * Framework-agnostic context optimization engine. Composable compression
 * pipeline that makes every token count — especially for small and local models.
 *
 * @module @cycgraph/context-engine
 */

// --- Provider Interfaces & Defaults ---

export type {
  TokenCounter,
  CompressionProvider,
  EmbeddingProvider,
  SummarizationProvider,
} from './providers/types.js';

export {
  DefaultTokenCounter,
  NoopCompressionProvider,
  NoopEmbeddingProvider,
  NoopSummarizationProvider,
  resolveTokenRatio,
} from './providers/defaults.js';

// --- Pipeline Core ---

export type {
  SegmentRole,
  PromptSegment,
  BudgetConfig,
  StageMetrics,
  PipelineMetrics,
  StageContext,
  StageResult,
  CompressionStage,
  PipelineConfig,
  PipelineInput,
  PipelineResult,
  SourceMapEntry,
  PipelineLogger,
} from './pipeline/types.js';

export {
  SegmentRoleSchema,
  PromptSegmentSchema,
  BudgetConfigSchema,
  noopLogger,
} from './pipeline/types.js';

export { createPipeline } from './pipeline/pipeline.js';

export type {
  PipelineState,
  IncrementalPipelineConfig,
  IncrementalResult,
} from './pipeline/incremental-pipeline.js';

export { createIncrementalPipeline } from './pipeline/incremental-pipeline.js';

export {
  computeStageMetrics,
  aggregateMetrics,
  formatMetricsSummary,
} from './pipeline/metrics.js';

// --- Format Compression ---

export type { DataShape } from './format/detector.js';
export { detectShape } from './format/detector.js';
export { serializeTabular } from './format/strategies/tabular.js';
export { serializeFlatObject } from './format/strategies/flat-object.js';
export { serializeNested } from './format/strategies/nested.js';

export type { FormatOptions } from './format/serializer.js';
export { serialize, createFormatStage } from './format/serializer.js';

// --- Pruning ---

export type {
  ScoredToken,
  TokenScorer,
  ScorerContext,
} from './pruning/types.js';

export { pruneByScore, createPruningStage } from './pruning/pruner.js';

export type { HeuristicScorerOptions } from './pruning/heuristic.js';
export { createHeuristicScorer, createHeuristicPruningStage } from './pruning/heuristic.js';

export type { NGramScorerOptions } from './pruning/ngram-scorer.js';
export { createNGramScorer } from './pruning/ngram-scorer.js';

export type {
  ReasoningDelimiter,
  CotDistillationOptions,
  CotDistillationResult,
} from './pruning/cot-distillation.js';
export {
  DEFAULT_DELIMITERS,
  distillCoT,
  createCotDistillationStage,
} from './pruning/cot-distillation.js';

// --- Deduplication ---

export type { DedupResult } from './memory/dedup/exact.js';
export { dedup, createExactDedupStage, fnv1a } from './memory/dedup/exact.js';

export type { FuzzyDedupResult, FuzzyDedupOptions } from './memory/dedup/fuzzy.js';
export {
  trigramSet,
  jaccardSimilarity,
  fuzzyDedup,
  createFuzzyDedupStage,
} from './memory/dedup/fuzzy.js';

// --- Budget Management ---

export {
  createTokenCounter,
  countSegmentTokens,
  countTotalTokens,
} from './budget/counter.js';

export type { AllocationResult, AllocatorStageOptions, AllocateBudgetOptions } from './budget/allocator.js';
export { allocateBudget, createAllocatorStage } from './budget/allocator.js';
export { scoreSegmentRelevance } from './budget/relevance.js';
export type { RelevanceOptions } from './budget/relevance.js';

export type { CachePolicyOptions } from './budget/cache-policy.js';
export {
  applyCachePolicy,
  computePrefixHashes,
  measureCacheHitRate,
  computePrefixHashList,
  measurePrefixStability,
  computeSegmentHashMap,
} from './budget/cache-policy.js';

export type { CacheDiagnostics } from './budget/cache-diagnostics.js';
export { diagnoseCacheStability } from './budget/cache-diagnostics.js';

// --- Memory Hierarchy Formatting ---

export type {
  HierarchyTheme,
  HierarchyFact,
  HierarchyEpisode,
  GraphEntity,
  GraphRelationship,
  MemoryPayload,
  CommunitySummary,
} from './memory/hierarchy/types.js';

export type { HierarchyFormatOptions } from './memory/hierarchy/hierarchy-formatter.js';
export { formatHierarchy, createHierarchyFormatterStage } from './memory/hierarchy/hierarchy-formatter.js';

// --- Graph Formatting ---

export type { GraphSerializerOptions } from './memory/graph/serializer.js';
export { serializeGraph, createGraphSerializerStage } from './memory/graph/serializer.js';

export type { CommunityFormatOptions } from './memory/graph/community-formatter.js';
export { formatCommunities, createCommunityFormatterStage } from './memory/graph/community-formatter.js';

// --- Adaptive Memory Compression ---

export type { AdaptiveCompressionOptions } from './memory/adaptive-compressor.js';
export { createAdaptiveMemoryStage } from './memory/adaptive-compressor.js';

// --- Semantic Dedup ---

export type { SemanticDedupOptions } from './memory/dedup/semantic.js';
export { createSemanticDedupStage, precomputeEmbeddings, simHashBuckets } from './memory/dedup/semantic.js';

// --- Model-Aware Routing ---

export type { ModelProfile } from './routing/model-profiles.js';
export { MODEL_PROFILES, resolveModelProfile } from './routing/model-profiles.js';

export type { FormatSelectorOptions, FormatSelection } from './routing/format-selector.js';
export { selectFormat, createFormatSelectorStage } from './routing/format-selector.js';

// --- Self-Information Pruning ---

export type { Granularity, SelfInformationOptions } from './pruning/self-information.js';
export {
  precomputeImportanceScores,
  createSelfInformationScorer,
  createSelfInformationStage,
} from './pruning/self-information.js';

// --- Latency & Circuit Breaker ---

export type { LatencyStats, LatencyTracker } from './budget/latency-tracker.js';
export { createLatencyTracker } from './budget/latency-tracker.js';

export type { CircuitBreakerOptions } from './budget/circuit-breaker.js';
export { createCircuitBreaker } from './budget/circuit-breaker.js';

// --- Pipeline Optimizer ---

export type { PipelinePreset, OptimizerOptions, OptimizedPipeline } from './budget/optimizer.js';
export { createOptimizedPipeline } from './budget/optimizer.js';

// --- Provider Adapters ---

export { createTiktokenCounter } from './providers/tiktoken-adapter.js';

