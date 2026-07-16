/**
 * Incremental Compression Pipeline
 *
 * Wraps the batch pipeline to avoid re-compressing unchanged segments
 * between turns. Uses FNV-1a hashing of the cache-relevant segment fields
 * (content, priority, locked, metadata) to detect changes and caches
 * compressed output for stable segments.
 *
 * Supports cross-segment cache awareness: stages with scope 'cross-segment'
 * are re-run on ALL segments whenever any segment changes, while per-segment
 * stages cache individually.
 *
 * ORDERING CONTRACT: stages are partitioned by scope and run in two phases —
 * all per-segment stages first (in configured order), then all cross-segment
 * stages (in configured order). A config that interleaves scopes (a
 * per-segment stage AFTER a cross-segment stage) executes in a different
 * order here than in the batch pipeline and may produce different output.
 * Order per-segment stages before cross-segment stages to keep the two
 * pipelines equivalent; a warning is logged at construction otherwise.
 *
 * @module pipeline/incremental-pipeline
 */

import type {
  CompressionStage,
  PipelineConfig,
  PipelineInput,
  PipelineLogger,
  PipelineResult,
  PipelineMetrics,
  PromptSegment,
  SourceMapEntry,
} from './types.js';
import { noopLogger } from './types.js';
import { createPipeline } from './pipeline.js';
import { aggregateMetrics, computeStageMetrics } from './metrics.js';
import { DefaultTokenCounter } from '../providers/defaults.js';
import { countTotalTokens } from '../budget/counter.js';
import { fnv1a } from '../memory/dedup/exact.js';

// --- Types ---

/** State carried between incremental pipeline turns. */
export interface PipelineState {
  /** Segment ID -> segment hash (content + cache-relevant attributes) from the previous turn. */
  segmentHashes: Map<string, number>;
  /** Segment ID -> compressed segment from the previous turn (final output after all stages). */
  compressedSegments: Map<string, PromptSegment>;
  /** Segment ID -> output after per-segment stages only. */
  perSegmentOutputs: Map<string, PromptSegment>;
  /** Segment ID -> hash of per-segment output (for detecting actual output changes). */
  perSegmentOutputHashes: Map<string, number>;
  /** Aggregate metrics from the previous turn. */
  lastMetrics: PipelineMetrics;
  /** Turn counter (starts at 1). */
  turnNumber: number;
  /** Fingerprint of the budget + model the cached outputs were produced under. */
  configFingerprint: number;
  /**
   * Segment ID -> provenance entry through the per-segment phase
   * (original input -> per-segment output). Debug mode only.
   */
  perSegmentSourceMap?: Map<string, SourceMapEntry>;
  /**
   * Segment ID -> provenance entry through the cross-segment phase
   * (per-segment output -> final output), from the last turn the
   * cross-segment stages actually ran. Reusable while the cross phase is
   * skipped: per-segment outputs are unchanged, so the cross transformation
   * they describe is too. Debug mode only.
   */
  crossSourceMap?: Map<string, SourceMapEntry>;
}

/** Configuration for the incremental pipeline. */
export interface IncrementalPipelineConfig extends PipelineConfig {
  /**
   * Segments whose hash hasn't changed between turns
   * reuse cached compressed output. Default: true.
   */
  enableCaching?: boolean;
}

/** Result of an incremental compression call. */
export interface IncrementalResult {
  result: PipelineResult;
  state: PipelineState;
  /** Number of segments that were reused from cache. */
  cachedSegmentCount: number;
  /** Number of segments that were freshly compressed. */
  freshSegmentCount: number;
}

// --- Helpers ---

/** Remove keys from a Map that are not in the valid set. */
function pruneStaleKeys<V>(map: Map<string, V>, validIds: Set<string>): void {
  for (const key of map.keys()) {
    if (!validIds.has(key)) map.delete(key);
  }
}

/**
 * Fingerprint the compression config (budget + model) that cached outputs
 * depend on. Two turns with identical segment content but a different budget or
 * model must NOT reuse each other's cache.
 */
function fingerprintConfig(input: PipelineInput): number {
  return fnv1a(JSON.stringify({ budget: input.budget, model: input.model ?? '' }));
}

/**
 * Hash the segment fields that compressed output depends on — not just
 * content. `priority` drives budget allocation, `locked` bypasses stages
 * entirely, and `metadata` is visible to custom stages, so a change to any
 * of them must invalidate the cache even when content is unchanged.
 */
function hashSegment(seg: PromptSegment): number {
  return fnv1a(
    JSON.stringify([seg.content, seg.priority ?? 1, seg.locked ?? false, seg.metadata ?? null]),
  );
}

/** Identity source-map entry for a segment no stage has touched yet. */
function identityEntry(seg: PromptSegment): SourceMapEntry {
  return { segmentId: seg.id, original: seg.content, compressed: seg.content, changedBy: [] };
}

/**
 * Compose per-segment-phase and cross-segment-phase provenance into a single
 * end-to-end entry (original input -> final output).
 */
function composeSourceMapEntry(
  perSeg: SourceMapEntry | undefined,
  cross: SourceMapEntry | undefined,
  fromCache: boolean,
): SourceMapEntry | undefined {
  // A cross-only entry is a segment a cross-segment stage introduced.
  const base = perSeg ?? cross;
  if (!base) return undefined;

  const entry: SourceMapEntry = { ...base, changedBy: [...base.changedBy] };
  if (perSeg && cross) {
    entry.compressed = cross.compressed;
    entry.changedBy.push(...cross.changedBy);
    if (cross.removed) {
      entry.removed = true;
      entry.removedBy = cross.removedBy;
    }
  }
  if (fromCache) entry.fromCache = true;
  return entry;
}

/**
 * Compose the final source map from the two phase maps, in input order with
 * stage-introduced segments appended.
 */
function composeSourceMap(
  segments: PromptSegment[],
  perSegMap: Map<string, SourceMapEntry>,
  crossMap: Map<string, SourceMapEntry>,
  fromCacheIds: Set<string>,
): SourceMapEntry[] {
  const entries: SourceMapEntry[] = [];
  const emitted = new Set<string>();

  const emit = (id: string) => {
    if (emitted.has(id)) return;
    emitted.add(id);
    const entry = composeSourceMapEntry(perSegMap.get(id), crossMap.get(id), fromCacheIds.has(id));
    if (entry) entries.push(entry);
  };

  for (const seg of segments) emit(seg.id);
  for (const id of perSegMap.keys()) emit(id);
  for (const id of crossMap.keys()) emit(id);

  return entries;
}

/**
 * Warn when a per-segment stage is configured after a cross-segment stage:
 * the incremental pipeline's two-phase execution reorders such configs
 * relative to the batch pipeline (see module docs).
 */
function warnOnInterleavedScopes(stages: CompressionStage[], logger: PipelineLogger): void {
  let firstCross: string | undefined;
  for (const stage of stages) {
    // Undeclared scope is treated as cross-segment (the safe default).
    if (stage.scope !== 'per-segment') {
      firstCross ??= stage.name;
    } else if (firstCross !== undefined) {
      logger.warn?.(
        `per-segment stage "${stage.name}" is configured after cross-segment stage "${firstCross}"; ` +
          `the incremental pipeline runs all per-segment stages before cross-segment ones, ` +
          `so execution order (and output) may diverge from the batch pipeline. ` +
          `Order per-segment stages first to keep them equivalent.`,
      );
      return;
    }
  }
}

// --- Implementation ---

/**
 * Partition stages into per-segment and cross-segment groups.
 *
 * Undeclared scope is treated as cross-segment: correct for any stage
 * (it always sees all segments) at the cost of caching. Per-segment caching
 * is opt-in via an explicit `scope: 'per-segment'` declaration.
 */
function partitionStages(stages: CompressionStage[]): {
  perSegmentStages: CompressionStage[];
  crossSegmentStages: CompressionStage[];
} {
  const perSegmentStages: CompressionStage[] = [];
  const crossSegmentStages: CompressionStage[] = [];

  for (const stage of stages) {
    if (stage.scope === 'per-segment') {
      perSegmentStages.push(stage);
    } else {
      crossSegmentStages.push(stage);
    }
  }

  return { perSegmentStages, crossSegmentStages };
}

/**
 * Create an incremental compression pipeline that caches compressed
 * output for unchanged segments between turns.
 *
 * Supports cross-segment cache awareness: stages marked with
 * `scope: 'cross-segment'` are re-run on all segments whenever any
 * segment's per-segment output changes, while per-segment stages
 * cache individually.
 *
 * NOTE: stages run in two phases — all per-segment stages, then all
 * cross-segment stages (see module docs). Configs that interleave scopes
 * diverge from the batch pipeline and trigger a construction-time warning.
 *
 * @example
 * ```ts
 * const pipeline = createIncrementalPipeline({
 *   stages: [createFormatStage(), createFuzzyDedupStage()],
 *   enableCaching: true,
 * });
 *
 * // First turn — all segments compressed
 * const turn1 = pipeline.compress({ segments, budget });
 *
 * // Second turn — only changed segments re-compressed through per-segment stages;
 * // cross-segment stages re-run if any segment changed
 * const turn2 = pipeline.compress({ segments, budget }, turn1.state);
 * ```
 */
export function createIncrementalPipeline(config: IncrementalPipelineConfig) {
  const enableCaching = config.enableCaching ?? true;
  const debug = config.debug ?? false;
  const logger: PipelineLogger = config.logger ?? noopLogger;
  const tokenCounter = config.tokenCounter ?? new DefaultTokenCounter();

  warnOnInterleavedScopes(config.stages, logger);

  return {
    compress(input: PipelineInput, previousState?: PipelineState): IncrementalResult {
      // Compute hashes for all current segments
      const currentHashes = new Map<string, number>();
      for (const seg of input.segments) {
        currentHashes.set(seg.id, hashSegment(seg));
      }

      const configFingerprint = fingerprintConfig(input);
      const { perSegmentStages, crossSegmentStages } = partitionStages(config.stages);
      const hasCrossSegmentStages = crossSegmentStages.length > 0;

      // If no previous state, caching disabled, OR the budget/model changed
      // since the cached run: run all stages fresh. Reusing cache across a
      // budget/model change would return output sized for the OLD budget.
      if (!previousState || !enableCaching || previousState.configFingerprint !== configFingerprint) {
        // Run per-segment stages on all segments
        const perSegmentOutputs = new Map<string, PromptSegment>();
        let perSegOrdered: PromptSegment[];
        let perSegMetrics: PipelineMetrics | undefined;
        let perSegSourceMapRaw: SourceMapEntry[] | undefined;

        if (perSegmentStages.length > 0) {
          const perSegPipeline = createPipeline({ ...config, stages: perSegmentStages });
          const perSegResult = perSegPipeline.compress(input);
          perSegOrdered = perSegResult.segments;
          perSegMetrics = perSegResult.metrics;
          perSegSourceMapRaw = perSegResult.sourceMap;
        } else {
          perSegOrdered = [...input.segments];
        }

        for (const seg of perSegOrdered) {
          perSegmentOutputs.set(seg.id, seg);
        }

        // Run cross-segment stages (if any) on per-segment output
        let finalSegments: PromptSegment[];
        let crossMetrics: PipelineMetrics | undefined;
        let crossSourceMapRaw: SourceMapEntry[] | undefined;

        if (crossSegmentStages.length > 0) {
          const crossPipeline = createPipeline({ ...config, stages: crossSegmentStages });
          const crossResult = crossPipeline.compress({ ...input, segments: perSegOrdered });
          finalSegments = crossResult.segments;
          crossMetrics = crossResult.metrics;
          crossSourceMapRaw = crossResult.sourceMap;
        } else {
          finalSegments = perSegOrdered;
        }

        const compressedSegments = new Map<string, PromptSegment>();
        for (const seg of finalSegments) {
          compressedSegments.set(seg.id, seg);
        }

        // Combine metrics from both phases
        const allStageMetrics = [
          ...(perSegMetrics?.stages ?? []),
          ...(crossMetrics?.stages ?? []),
        ];
        const metrics = allStageMetrics.length > 0
          ? aggregateMetrics(allStageMetrics)
          : aggregateMetrics([computeStageMetrics('(none)', 0, 0, 0)]);

        // Compute per-segment output hashes for future cross-segment change detection
        const perSegmentOutputHashes = new Map<string, number>();
        for (const [id, seg] of perSegmentOutputs) {
          perSegmentOutputHashes.set(id, hashSegment(seg));
        }

        // Build phase-level provenance (debug mode only)
        let sourceMap: SourceMapEntry[] | undefined;
        let perSegSM: Map<string, SourceMapEntry> | undefined;
        let crossSM: Map<string, SourceMapEntry> | undefined;
        if (debug) {
          perSegSM = new Map();
          if (perSegSourceMapRaw) {
            for (const e of perSegSourceMapRaw) perSegSM.set(e.segmentId, e);
          } else {
            for (const seg of input.segments) {
              if (!seg.locked) perSegSM.set(seg.id, identityEntry(seg));
            }
          }
          crossSM = new Map();
          for (const e of crossSourceMapRaw ?? []) crossSM.set(e.segmentId, e);
          sourceMap = composeSourceMap(input.segments, perSegSM, crossSM, new Set());
        }

        const state: PipelineState = {
          segmentHashes: currentHashes,
          compressedSegments,
          perSegmentOutputs,
          perSegmentOutputHashes,
          lastMetrics: metrics,
          turnNumber: (previousState?.turnNumber ?? 0) + 1,
          configFingerprint,
          perSegmentSourceMap: perSegSM,
          crossSourceMap: crossSM,
        };

        // Defensive: ensure no stale segment keys survive
        const validIds = new Set(input.segments.map(s => s.id));
        pruneStaleKeys(state.segmentHashes, validIds);
        pruneStaleKeys(state.compressedSegments, validIds);
        pruneStaleKeys(state.perSegmentOutputs, validIds);
        pruneStaleKeys(state.perSegmentOutputHashes, validIds);
        if (state.perSegmentSourceMap) pruneStaleKeys(state.perSegmentSourceMap, validIds);
        if (state.crossSourceMap) pruneStaleKeys(state.crossSourceMap, validIds);

        return {
          result: { segments: finalSegments, metrics, sourceMap },
          state,
          cachedSegmentCount: 0,
          freshSegmentCount: input.segments.length,
        };
      }

      // --- Incremental path with caching ---

      // Determine which segments are cached vs fresh based on hash
      const cachedIds = new Set<string>();
      const freshIds = new Set<string>();

      for (const seg of input.segments) {
        const currentHash = currentHashes.get(seg.id)!;
        const previousHash = previousState.segmentHashes.get(seg.id);

        if (
          previousHash !== undefined &&
          previousHash === currentHash &&
          previousState.perSegmentOutputs.has(seg.id)
        ) {
          cachedIds.add(seg.id);
        } else {
          freshIds.add(seg.id);
        }
      }

      // --- Per-segment phase ---
      const perSegmentOutputs = new Map<string, PromptSegment>();
      let anyPerSegmentFresh = false;
      let perSegMetrics: PipelineMetrics | undefined;
      let freshSourceMapRaw: SourceMapEntry[] | undefined;

      if (perSegmentStages.length > 0) {
        // Reuse cached per-segment outputs for unchanged segments
        for (const seg of input.segments) {
          if (cachedIds.has(seg.id)) {
            perSegmentOutputs.set(seg.id, previousState.perSegmentOutputs.get(seg.id)!);
          }
        }

        // Run fresh segments through per-segment stages
        const freshSegments = input.segments.filter(s => freshIds.has(s.id));
        if (freshSegments.length > 0) {
          anyPerSegmentFresh = true;
          const perSegPipeline = createPipeline({ ...config, stages: perSegmentStages });
          const freshInput: PipelineInput = { ...input, segments: freshSegments };
          const freshResult = perSegPipeline.compress(freshInput);
          perSegMetrics = freshResult.metrics;
          freshSourceMapRaw = freshResult.sourceMap;
          for (const seg of freshResult.segments) {
            perSegmentOutputs.set(seg.id, seg);
          }
        }
      } else {
        // No per-segment stages: per-segment output is the raw input
        for (const seg of input.segments) {
          if (cachedIds.has(seg.id)) {
            perSegmentOutputs.set(seg.id, previousState.perSegmentOutputs.get(seg.id)!);
          } else {
            anyPerSegmentFresh = true;
            perSegmentOutputs.set(seg.id, seg);
          }
        }
      }

      // Per-segment phase provenance: fresh entries from this turn's run,
      // cached entries carried over from previous turns (debug mode only)
      let perSegSM: Map<string, SourceMapEntry> | undefined;
      if (debug) {
        perSegSM = new Map();
        for (const seg of input.segments) {
          if (seg.locked || !cachedIds.has(seg.id)) continue;
          const prev = previousState.perSegmentSourceMap?.get(seg.id);
          if (prev) {
            perSegSM.set(seg.id, prev);
          } else {
            // State predates debug mode — synthesize an entry from the cached
            // output; stage attribution for this segment is unknown.
            const out = perSegmentOutputs.get(seg.id)!;
            perSegSM.set(seg.id, {
              segmentId: seg.id,
              original: seg.content,
              compressed: out.content,
              changedBy: [],
            });
          }
        }
        if (freshSourceMapRaw) {
          for (const e of freshSourceMapRaw) perSegSM.set(e.segmentId, e);
        } else if (perSegmentStages.length === 0) {
          for (const seg of input.segments) {
            if (!seg.locked && freshIds.has(seg.id)) perSegSM.set(seg.id, identityEntry(seg));
          }
        }
      }

      // Assemble per-segment outputs in original order
      const perSegmentOrdered = input.segments.map(s => perSegmentOutputs.get(s.id)!);

      // --- Cross-segment phase ---
      // Check if any per-segment OUTPUT actually changed (not just input).
      // A fresh input might produce the same per-segment output, in which
      // case cross-segment stages don't need to re-run.
      let anyPerSegOutputChanged = false;
      if (previousState.perSegmentOutputHashes) {
        for (const [id, seg] of perSegmentOutputs) {
          const newHash = hashSegment(seg);
          const prevHash = previousState.perSegmentOutputHashes.get(id);
          if (prevHash === undefined || prevHash !== newHash) {
            anyPerSegOutputChanged = true;
            break;
          }
        }
      } else {
        // No previous output hashes (legacy state) — fall back to input-based detection
        anyPerSegOutputChanged = anyPerSegmentFresh || freshIds.size > 0;
      }

      let outputSegments: PromptSegment[];
      let crossMetrics: PipelineMetrics | undefined;
      let crossSM: Map<string, SourceMapEntry> | undefined;
      let crossReused = false;

      if (!hasCrossSegmentStages) {
        // No cross-segment stages: per-segment outputs ARE the final outputs
        outputSegments = perSegmentOrdered;
        if (debug) crossSM = new Map();
      } else if (anyPerSegOutputChanged) {
        // Per-segment outputs actually changed: re-run cross-segment stages on ALL segments
        const crossPipeline = createPipeline({ ...config, stages: crossSegmentStages });
        const crossInput: PipelineInput = { ...input, segments: perSegmentOrdered };
        const crossResult = crossPipeline.compress(crossInput);
        outputSegments = crossResult.segments;
        crossMetrics = crossResult.metrics;
        if (debug) {
          crossSM = new Map();
          for (const e of crossResult.sourceMap ?? []) crossSM.set(e.segmentId, e);
        }
      } else {
        // Everything cached: reuse final output from the previous turn.
        // A segment absent from compressedSegments was removed by a
        // cross-segment stage last turn; honor that decision (per-segment
        // outputs are unchanged, so a re-run would remove it again).
        outputSegments = [];
        for (const s of input.segments) {
          const cachedFinal = previousState.compressedSegments.get(s.id);
          if (cachedFinal) outputSegments.push(cachedFinal);
        }
        crossReused = true;
        if (debug) crossSM = new Map(previousState.crossSourceMap ?? []);
      }

      // Compose end-to-end provenance for this turn (debug mode only)
      let sourceMap: SourceMapEntry[] | undefined;
      if (debug && perSegSM && crossSM) {
        const fromCacheIds = new Set<string>(cachedIds);
        if (crossReused) {
          for (const id of crossSM.keys()) fromCacheIds.add(id);
        }
        sourceMap = composeSourceMap(input.segments, perSegSM, crossSM, fromCacheIds);
      }

      // --- Build metrics ---
      const allCached = freshIds.size === 0;
      let metrics: PipelineMetrics;

      if (allCached) {
        // Nothing changed — reuse last turn's metrics with a cached flag
        metrics = { ...previousState.lastMetrics, cached: true };
      } else {
        // Aggregate real metrics from pipeline runs that actually executed.
        // Per-stage entries reflect the segments each run processed this turn
        // (per-segment stages: fresh subset; cross-segment stages: all), so the
        // chain boundaries aggregateMetrics reads are NOT full-prompt totals —
        // measure those directly instead.
        const allStageMetrics: import('./types.js').StageMetrics[] = [];
        if (perSegMetrics?.stages) {
          allStageMetrics.push(...perSegMetrics.stages);
        }
        if (crossMetrics?.stages) {
          allStageMetrics.push(...crossMetrics.stages);
        }
        const aggregated = allStageMetrics.length > 0
          ? aggregateMetrics(allStageMetrics)
          : aggregateMetrics([computeStageMetrics('(none)', 0, 0, 0)]);

        const totalTokensIn = countTotalTokens(input.segments, tokenCounter, input.model);
        const totalTokensOut = countTotalTokens(outputSegments, tokenCounter, input.model);
        metrics = {
          ...aggregated,
          totalTokensIn,
          totalTokensOut,
          overallRatio: totalTokensIn > 0 ? totalTokensOut / totalTokensIn : 1.0,
          reductionPercent: totalTokensIn > 0
            ? ((totalTokensIn - totalTokensOut) / totalTokensIn) * 100
            : 0,
        };
      }

      // --- Build new state ---
      const compressedSegments = new Map<string, PromptSegment>();
      for (const seg of outputSegments) {
        compressedSegments.set(seg.id, seg);
      }

      // Compute per-segment output hashes for future cross-segment change detection
      const perSegmentOutputHashes = new Map<string, number>();
      for (const [id, seg] of perSegmentOutputs) {
        perSegmentOutputHashes.set(id, hashSegment(seg));
      }

      const state: PipelineState = {
        segmentHashes: currentHashes,
        compressedSegments,
        perSegmentOutputs,
        perSegmentOutputHashes,
        lastMetrics: metrics,
        turnNumber: previousState.turnNumber + 1,
        configFingerprint,
        perSegmentSourceMap: perSegSM,
        crossSourceMap: crossSM,
      };

      // Defensive: ensure no stale segment keys survive
      const validIds = new Set(input.segments.map(s => s.id));
      pruneStaleKeys(state.segmentHashes, validIds);
      pruneStaleKeys(state.compressedSegments, validIds);
      pruneStaleKeys(state.perSegmentOutputs, validIds);
      pruneStaleKeys(state.perSegmentOutputHashes, validIds);
      if (state.perSegmentSourceMap) pruneStaleKeys(state.perSegmentSourceMap, validIds);
      if (state.crossSourceMap) pruneStaleKeys(state.crossSourceMap, validIds);

      return {
        result: { segments: outputSegments, metrics, sourceMap },
        state,
        cachedSegmentCount: cachedIds.size,
        freshSegmentCount: freshIds.size,
      };
    },
  };
}
