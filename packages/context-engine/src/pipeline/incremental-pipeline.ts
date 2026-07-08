/**
 * Incremental Compression Pipeline
 *
 * Wraps the batch pipeline to avoid re-compressing unchanged segments
 * between turns. Uses FNV-1a content hashing to detect changes and
 * caches compressed output for stable segments.
 *
 * Supports cross-segment cache awareness: stages with scope 'cross-segment'
 * are re-run on ALL segments whenever any segment changes, while per-segment
 * stages cache individually.
 *
 * @module pipeline/incremental-pipeline
 */

import type {
  CompressionStage,
  PipelineConfig,
  PipelineInput,
  PipelineResult,
  PipelineMetrics,
  PromptSegment,
} from './types.js';
import { createPipeline } from './pipeline.js';
import { aggregateMetrics, computeStageMetrics } from './metrics.js';
import { fnv1a } from '../memory/dedup/exact.js';

// --- Types ---

/** State carried between incremental pipeline turns. */
export interface PipelineState {
  /** Segment ID -> content hash from the previous turn. */
  segmentHashes: Map<string, number>;
  /** Segment ID -> compressed segment from the previous turn (final output after all stages). */
  compressedSegments: Map<string, PromptSegment>;
  /** Segment ID -> output after per-segment stages only. */
  perSegmentOutputs: Map<string, PromptSegment>;
  /** Segment ID -> hash of per-segment output content (for detecting actual output changes). */
  perSegmentOutputHashes: Map<string, number>;
  /** Aggregate metrics from the previous turn. */
  lastMetrics: PipelineMetrics;
  /** Turn counter (starts at 1). */
  turnNumber: number;
  /**
   * Fingerprint of the budget + model the cached outputs were produced under.
   * Compressed output depends on the budget (allocator truncates to it) and the
   * model (token counts, format selection) — NOT just segment content. If the
   * caller changes budget/model between turns, every cached segment is stale
   * (e.g. a segment compressed for an 8k budget must not be reused verbatim
   * under a 2k budget → provider overflow), so the whole cache is invalidated.
   */
  configFingerprint: number;
}

/** Configuration for the incremental pipeline. */
export interface IncrementalPipelineConfig extends PipelineConfig {
  /**
   * Segments whose content hash hasn't changed between turns
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

// --- Implementation ---

/**
 * Partition stages into per-segment and cross-segment groups.
 */
function partitionStages(stages: CompressionStage[]): {
  perSegmentStages: CompressionStage[];
  crossSegmentStages: CompressionStage[];
} {
  const perSegmentStages: CompressionStage[] = [];
  const crossSegmentStages: CompressionStage[] = [];

  for (const stage of stages) {
    if (stage.scope === 'cross-segment') {
      crossSegmentStages.push(stage);
    } else {
      perSegmentStages.push(stage);
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

  return {
    compress(input: PipelineInput, previousState?: PipelineState): IncrementalResult {
      // Compute hashes for all current segments
      const currentHashes = new Map<string, number>();
      for (const seg of input.segments) {
        currentHashes.set(seg.id, fnv1a(seg.content));
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

        if (perSegmentStages.length > 0) {
          const perSegPipeline = createPipeline({ ...config, stages: perSegmentStages });
          const perSegResult = perSegPipeline.compress(input);
          perSegOrdered = perSegResult.segments;
          perSegMetrics = perSegResult.metrics;
        } else {
          perSegOrdered = [...input.segments];
        }

        for (const seg of perSegOrdered) {
          perSegmentOutputs.set(seg.id, seg);
        }

        // Run cross-segment stages (if any) on per-segment output
        let finalSegments: PromptSegment[];
        let crossMetrics: PipelineMetrics | undefined;

        if (crossSegmentStages.length > 0) {
          const crossPipeline = createPipeline({ ...config, stages: crossSegmentStages });
          const crossResult = crossPipeline.compress({ ...input, segments: perSegOrdered });
          finalSegments = crossResult.segments;
          crossMetrics = crossResult.metrics;
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
          perSegmentOutputHashes.set(id, fnv1a(seg.content));
        }

        const state: PipelineState = {
          segmentHashes: currentHashes,
          compressedSegments,
          perSegmentOutputs,
          perSegmentOutputHashes,
          lastMetrics: metrics,
          turnNumber: (previousState?.turnNumber ?? 0) + 1,
          configFingerprint,
        };

        // Defensive: ensure no stale segment keys survive
        const validIds = new Set(input.segments.map(s => s.id));
        pruneStaleKeys(state.segmentHashes, validIds);
        pruneStaleKeys(state.compressedSegments, validIds);
        pruneStaleKeys(state.perSegmentOutputs, validIds);
        pruneStaleKeys(state.perSegmentOutputHashes, validIds);

        return {
          result: { segments: finalSegments, metrics },
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

      // Assemble per-segment outputs in original order
      const perSegmentOrdered = input.segments.map(s => perSegmentOutputs.get(s.id)!);

      // --- Cross-segment phase ---
      // Check if any per-segment OUTPUT actually changed (not just input).
      // A fresh input might produce the same per-segment output, in which
      // case cross-segment stages don't need to re-run.
      let anyPerSegOutputChanged = false;
      if (previousState.perSegmentOutputHashes) {
        for (const [id, seg] of perSegmentOutputs) {
          const newHash = fnv1a(seg.content);
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

      if (!hasCrossSegmentStages) {
        // No cross-segment stages: per-segment outputs ARE the final outputs
        outputSegments = perSegmentOrdered;
      } else if (anyPerSegOutputChanged) {
        // Per-segment outputs actually changed: re-run cross-segment stages on ALL segments
        const crossPipeline = createPipeline({ ...config, stages: crossSegmentStages });
        const crossInput: PipelineInput = { ...input, segments: perSegmentOrdered };
        const crossResult = crossPipeline.compress(crossInput);
        outputSegments = crossResult.segments;
        crossMetrics = crossResult.metrics;
      } else {
        // Everything cached: reuse final output from previous state
        outputSegments = input.segments.map(
          s => previousState.compressedSegments.get(s.id) ?? perSegmentOutputs.get(s.id)!,
        );
      }

      // --- Build metrics ---
      const allCached = freshIds.size === 0;
      let metrics: PipelineMetrics;

      if (allCached) {
        // Nothing changed — reuse last turn's metrics with a cached flag
        metrics = { ...previousState.lastMetrics, cached: true };
      } else {
        // Aggregate real metrics from pipeline runs that actually executed
        const allStageMetrics: import('./types.js').StageMetrics[] = [];
        if (perSegMetrics?.stages) {
          allStageMetrics.push(...perSegMetrics.stages);
        }
        if (crossMetrics?.stages) {
          allStageMetrics.push(...crossMetrics.stages);
        }
        metrics = allStageMetrics.length > 0
          ? aggregateMetrics(allStageMetrics)
          : aggregateMetrics([computeStageMetrics('(none)', 0, 0, 0)]);
      }

      // --- Build new state ---
      const compressedSegments = new Map<string, PromptSegment>();
      for (const seg of outputSegments) {
        compressedSegments.set(seg.id, seg);
      }

      // Compute per-segment output hashes for future cross-segment change detection
      const perSegmentOutputHashes = new Map<string, number>();
      for (const [id, seg] of perSegmentOutputs) {
        perSegmentOutputHashes.set(id, fnv1a(seg.content));
      }

      const state: PipelineState = {
        segmentHashes: currentHashes,
        compressedSegments,
        perSegmentOutputs,
        perSegmentOutputHashes,
        lastMetrics: metrics,
        turnNumber: previousState.turnNumber + 1,
        configFingerprint,
      };

      // Defensive: ensure no stale segment keys survive
      const validIds = new Set(input.segments.map(s => s.id));
      pruneStaleKeys(state.segmentHashes, validIds);
      pruneStaleKeys(state.compressedSegments, validIds);
      pruneStaleKeys(state.perSegmentOutputs, validIds);
      pruneStaleKeys(state.perSegmentOutputHashes, validIds);

      return {
        result: { segments: outputSegments, metrics },
        state,
        cachedSegmentCount: cachedIds.size,
        freshSegmentCount: freshIds.size,
      };
    },
  };
}

