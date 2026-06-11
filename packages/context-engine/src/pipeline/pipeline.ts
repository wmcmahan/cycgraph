/**
 * Compression Pipeline
 *
 * The core executor that chains compression stages together. Each stage
 * receives segments and returns compressed segments. Locked segments
 * bypass all stages. Debug mode records source maps for traceability.
 *
 * @module pipeline/pipeline
 */

import type {
  PipelineConfig,
  PipelineInput,
  PipelineResult,
  PipelineLogger,
  PromptSegment,
  StageContext,
  StageMetrics,
  SourceMapEntry,
} from './types.js';
import { BudgetConfigSchema, noopLogger } from './types.js';
import { DefaultTokenCounter } from '../providers/defaults.js';
import { computeStageMetrics, aggregateMetrics } from './metrics.js';

/**
 * Create a compression pipeline from a configuration.
 *
 * @example
 * ```ts
 * const pipeline = createPipeline({
 *   stages: [createFormatStage(), createExactDedupStage()],
 *   debug: true,
 * });
 * const result = pipeline.compress({
 *   segments: [{ id: 'mem', content: jsonString, role: 'memory', priority: 1 }],
 *   budget: { maxTokens: 4096, outputReserve: 512 },
 *   model: 'claude-sonnet-4-6',
 * });
 * ```
 */
export function createPipeline(config: PipelineConfig) {
  const tokenCounter = config.tokenCounter ?? new DefaultTokenCounter();
  const debug = config.debug ?? false;
  const logger: PipelineLogger = config.logger ?? noopLogger;
  const timeoutMs = config.timeoutMs;

  return {
    compress(input: PipelineInput): PipelineResult {
      const budget = BudgetConfigSchema.parse(input.budget);

      const context: StageContext = {
        tokenCounter,
        budget,
        model: input.model,
        debug,
      };

      // Separate locked vs mutable segments
      const lockedSegments: PromptSegment[] = [];
      let mutableSegments: PromptSegment[] = [];
      for (const seg of input.segments) {
        if (seg.locked) {
          lockedSegments.push(seg);
        } else {
          mutableSegments.push(seg);
        }
      }

      // Track source map entries in debug mode
      const sourceMap: SourceMapEntry[] = [];
      if (debug) {
        for (const seg of mutableSegments) {
          sourceMap.push({
            segmentId: seg.id,
            original: seg.content,
            compressed: seg.content, // updated after pipeline
          });
        }
      }

      // Measure initial token count (all segments)
      const allInitial = [...lockedSegments, ...mutableSegments];
      const initialTokens = countSegments(allInitial, tokenCounter, input.model);

      const stageMetrics: StageMetrics[] = [];
      const pipelineStart = performance.now();

      // Execute each stage on mutable segments only
      for (const stage of config.stages) {
        // Pipeline-level timeout: skip remaining stages if budget exceeded
        if (timeoutMs !== undefined && (performance.now() - pipelineStart) > timeoutMs) {
          logger.warn?.(`pipeline timeout (${timeoutMs}ms) exceeded, skipping stage "${stage.name}" and remaining stages`);
          break;
        }

        const tokensIn = countSegments(mutableSegments, tokenCounter, input.model);
        const start = performance.now();

        try {
          const result = stage.execute(mutableSegments, context);
          const durationMs = performance.now() - start;
          const tokensOut = countSegments(result.segments, tokenCounter, input.model);

          stageMetrics.push(computeStageMetrics(stage.name, tokensIn, tokensOut, durationMs));
          mutableSegments = result.segments;
        } catch (err) {
          // Graceful degradation: pass input through on error
          const durationMs = performance.now() - start;
          stageMetrics.push(computeStageMetrics(stage.name, tokensIn, tokensIn, durationMs, true));
          logger.warn?.(`stage "${stage.name}" threw, passing through: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // Recombine locked + compressed segments (preserve original order)
      const outputSegments = recombineSegments(input.segments, lockedSegments, mutableSegments);

      // Finalize metrics: use total (locked + mutable) for first/last stage
      const finalTokens = countSegments(outputSegments, tokenCounter, input.model);
      const adjustedMetrics = adjustMetricsForLocked(stageMetrics, initialTokens, finalTokens);

      // Update source map with final compressed content
      if (debug) {
        for (const entry of sourceMap) {
          const seg = mutableSegments.find(s => s.id === entry.segmentId);
          if (seg) entry.compressed = seg.content;
        }
      }

      return {
        segments: outputSegments,
        metrics: adjustedMetrics,
        sourceMap: debug ? sourceMap : undefined,
      };
    },
  };
}

/** Count total tokens across all segments. */
function countSegments(segments: PromptSegment[], counter: { countTokens: (text: string, model?: string) => number }, model?: string): number {
  let total = 0;
  for (const seg of segments) {
    total += counter.countTokens(seg.content, model);
  }
  return total;
}

/**
 * Recombine locked and mutable segments in original input order.
 * Uses segment IDs to map back to the correct position.
 */
function recombineSegments(
  original: PromptSegment[],
  locked: PromptSegment[],
  mutable: PromptSegment[],
): PromptSegment[] {
  const lockedMap = new Map(locked.map(s => [s.id, s]));
  const mutableMap = new Map(mutable.map(s => [s.id, s]));

  return original.map(orig => {
    if (orig.locked) return lockedMap.get(orig.id) ?? orig;
    return mutableMap.get(orig.id) ?? orig;
  });
}

/**
 * Adjust per-stage metrics to reflect the full pipeline (locked + mutable).
 * The first stage's tokensIn and last stage's tokensOut are replaced
 * with the total across all segments.
 */
function adjustMetricsForLocked(
  stageMetrics: StageMetrics[],
  totalTokensIn: number,
  totalTokensOut: number,
): import('./types.js').PipelineMetrics {
  if (stageMetrics.length === 0) {
    return aggregateMetrics([
      computeStageMetrics('(none)', totalTokensIn, totalTokensOut, 0),
    ]);
  }

  // Replace aggregate boundaries with full counts
  const adjusted = [...stageMetrics];
  adjusted[0] = { ...adjusted[0], tokensIn: totalTokensIn };
  adjusted[adjusted.length - 1] = { ...adjusted[adjusted.length - 1], tokensOut: totalTokensOut };

  return aggregateMetrics(adjusted);
}
