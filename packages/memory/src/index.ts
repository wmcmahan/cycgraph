/**
 * @cycgraph/memory — Public API
 *
 * Temporal and hierarchical memory service for LLM agents.
 * All public types, classes, and functions are re-exported here.
 *
 * @packageDocumentation
 */

// ─── Schemas ───────────────────────────────────────────────────────
// Zod schemas and inferred TypeScript types

export {
  ProvenanceSchema,
  EntitySchema,
  RelationshipSchema,
  MessageSchema,
  EpisodeSchema,
  SemanticFactSchema,
  ThemeSchema,
  MemoryQuerySchema,
  MemoryResultSchema,
} from './schemas/index.js';

export type {
  Provenance,
  Entity,
  EntityInput,
  Relationship,
  RelationshipInput,
  Message,
  Episode,
  EpisodeInput,
  SemanticFact,
  SemanticFactInput,
  Theme,
  ThemeInput,
  MemoryQuery,
  MemoryResult,
} from './schemas/index.js';

// ─── Interfaces ────────────────────────────────────────────────────
// Contracts for storage, search, and processing

export { QUARANTINE_TAG } from './interfaces/memory-store.js';

export type {
  MemoryStore,
  EntityFilter,
  FactFilter,
  RelationshipFilter,
  PaginationOptions,
} from './interfaces/memory-store.js';

export type {
  MemoryIndex,
  ScoredResult,
  SearchOptions,
} from './interfaces/memory-index.js';

export type { EpisodeSegmenter } from './interfaces/episode-segmenter.js';
export type { SemanticExtractor, ExtractionResult } from './interfaces/semantic-extractor.js';
export type { ThemeClusterer } from './interfaces/theme-clusterer.js';
export type { EmbeddingProvider } from './interfaces/embedding-provider.js';

// ─── In-Memory Implementations ────────────────────────────────────
// Zero-dependency implementations for testing and lightweight use

export { InMemoryMemoryStore } from './store/in-memory-store.js';
export { InMemoryMemoryIndex, EmbeddingDimensionMismatchError, IN_MEMORY_INDEX_WARN_THRESHOLD } from './search/in-memory-index.js';
export type { InMemoryMemoryIndexOptions } from './search/in-memory-index.js';
export { batchGetFallback } from './store/batch-mixin.js';

// ─── Hierarchy (xMemory Pipeline) ─────────────────────────────────
// Messages → Episodes → Facts → Themes

export { SimpleEpisodeSegmenter } from './hierarchy/simple-episode-segmenter.js';
export type { SimpleEpisodeSegmenterOptions } from './hierarchy/simple-episode-segmenter.js';

export { SimpleSemanticExtractor } from './hierarchy/simple-semantic-extractor.js';

export { SimpleThemeClusterer, assignThemeIds } from './hierarchy/simple-theme-clusterer.js';
export type { SimpleThemeClustererOptions } from './hierarchy/simple-theme-clusterer.js';

export { RuleBasedExtractor } from './hierarchy/rule-based-extractor.js';
export type { RuleBasedExtractorOptions, ExtractedEntity } from './hierarchy/rule-based-extractor.js';

export { LLMExtractor } from './hierarchy/llm-extractor.js';
export type { LLMExtractorOptions, LLMProvider, ExtractorLogger } from './hierarchy/llm-extractor.js';

export { ConsolidatingThemeClusterer } from './hierarchy/consolidating-theme-clusterer.js';
export type { ConsolidatingThemeClustererOptions } from './hierarchy/consolidating-theme-clusterer.js';

// ─── Retrieval ─────────────────────────────────────────────────────
// Subgraph extraction, hierarchical top-down, temporal filtering

export { extractSubgraph } from './retrieval/subgraph-extractor.js';
export type { SubgraphOptions, SubgraphResult } from './retrieval/subgraph-extractor.js';

export { retrieveMemory } from './retrieval/hierarchical-retriever.js';

export { isValidAt, isChangedSince, filterValid } from './retrieval/temporal-filter.js';
export type { TemporalRecord, TemporalFilterOptions } from './retrieval/temporal-filter.js';

export { retrieveGatedLessons } from './retrieval/gated-lesson-retriever.js';
export type { GatedLessonOptions } from './retrieval/gated-lesson-retriever.js';

// ─── Consolidation ───────────────────────────────────────────────

export { MemoryConsolidator } from './consolidation/memory-consolidator.js';
export type { ConsolidationOptions, ConsolidationReport, AutoConsolidationThresholds, ConsolidationLogger } from './consolidation/memory-consolidator.js';

export { ConflictDetector } from './consolidation/conflict-detector.js';
export type { ConflictDetectorOptions, Conflict, ConflictResolutionPolicy, ConflictResolutionReport } from './consolidation/conflict-detector.js';

export { EntityResolver, normalizeEntityName } from './consolidation/entity-resolver.js';
export type { EntityResolutionOptions, EntityResolutionReport, EntityResolutionLogger } from './consolidation/entity-resolver.js';

export { InMemoryOutcomeLedger, RunOutcomeSchema } from './consolidation/outcome-ledger.js';
export type { OutcomeLedger, RunOutcome, FactStats, OutcomeBaseline } from './consolidation/outcome-ledger.js';

export { evaluateRetention, RetentionPolicySchema } from './consolidation/retention-gate.js';
export type { RetentionPolicy, RetentionReport, RetentionEvidence, EvictionReason } from './consolidation/retention-gate.js';

// ─── Utilities ─────────────────────────────────────────────────────

export { cosineSimilarity } from './utils/similarity.js';

export {
  studentTCdf,
  welchLift,
  benjaminiHochberg,
  normalQuantile,
  requiredTrials,
  mulberry32,
  gaussian,
} from './utils/statistics.js';
export type { WelchLiftInput, WelchLiftResult, RequiredTrialsInput } from './utils/statistics.js';

// ─── Validation ────────────────────────────────────────────────────
// Measure the retention gate's realized error rates for YOUR policy
// before trusting it — see validation/gate-simulator.ts.

export { simulateGate, gateOperatingCharacteristics } from './validation/gate-simulator.js';
export type {
  SimulatedLesson,
  GateSimulationConfig,
  GateSimulationResult,
  SimulatedLessonOutcome,
  OperatingCharacteristicsConfig,
  OperatingCharacteristicsRow,
} from './validation/gate-simulator.js';
