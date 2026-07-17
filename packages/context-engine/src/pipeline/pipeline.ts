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
import { countTotalTokens } from '../budget/counter.js';
import { resolveModelProfile } from '../routing/model-profiles.js';
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

      // Sanity check: a budget larger than the model's context window means
      // "within budget" output can still overflow the provider.
      const profile = resolveModelProfile(input.model);
      if (profile && budget.maxTokens > profile.maxContextTokens) {
        logger.warn?.(
          `budget.maxTokens (${budget.maxTokens}) exceeds the ${profile.family} context window (${profile.maxContextTokens})`,
        );
      }

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

      // Locked segments bypass compression but still occupy context window:
      // charge their tokens against the budget so stages size the mutable
      // segments to what actually remains.
      const lockedTokens = countTotalTokens(lockedSegments, tokenCounter, input.model);
      const context: StageContext = {
        tokenCounter,
        budget: { ...budget, maxTokens: Math.max(0, budget.maxTokens - lockedTokens) },
        model: input.model,
        query: input.query,
        debug,
        logger,
      };

      // Track source map entries in debug mode
      const sourceMap: SourceMapEntry[] = [];
      if (debug) {
        for (const seg of mutableSegments) {
          sourceMap.push({
            segmentId: seg.id,
            original: seg.content,
            compressed: seg.content, // updated after pipeline
            changedBy: [],
          });
        }
      }

      // Measure initial token count (all segments)
      const allInitial = [...lockedSegments, ...mutableSegments];
      const initialTokens = countTotalTokens(allInitial, tokenCounter, input.model);

      const stageMetrics: StageMetrics[] = [];
      const pipelineStart = performance.now();

      // Execute each stage on mutable segments only
      for (const stage of config.stages) {
        // Pipeline-level timeout: skip remaining stages if budget exceeded
        if (timeoutMs !== undefined && (performance.now() - pipelineStart) > timeoutMs) {
          logger.warn?.(`pipeline timeout (${timeoutMs}ms) exceeded, skipping stage "${stage.name}" and remaining stages`);
          break;
        }

        const tokensIn = countTotalTokens(mutableSegments, tokenCounter, input.model);
        const start = performance.now();

        try {
          const result = stage.execute(mutableSegments, context);
          const durationMs = performance.now() - start;
          const tokensOut = countTotalTokens(result.segments, tokenCounter, input.model);

          stageMetrics.push(computeStageMetrics(stage.name, tokensIn, tokensOut, durationMs));

          if (debug) {
            recordStageProvenance(sourceMap, mutableSegments, result.segments, stage.name);
          }

          mutableSegments = result.segments;
        } catch (err) {
          // Graceful degradation: pass input through on error
          const durationMs = performance.now() - start;
          stageMetrics.push(computeStageMetrics(stage.name, tokensIn, tokensIn, durationMs, true));
          logger.warn?.(`stage "${stage.name}" threw, passing through: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // Recombine locked + compressed segments (preserve original order)
      const outputSegments = recombineSegments(input.segments, lockedSegments, mutableSegments, logger);

      // Finalize metrics: use total (locked + mutable) for first/last stage
      const finalTokens = countTotalTokens(outputSegments, tokenCounter, input.model);
      const adjustedMetrics = adjustMetricsForLocked(stageMetrics, initialTokens, finalTokens);

      // Update source map with final compressed content
      if (debug) {
        const finalById = new Map(mutableSegments.map(s => [s.id, s]));
        for (const entry of sourceMap) {
          const seg = finalById.get(entry.segmentId);
          if (seg) {
            entry.compressed = seg.content;
          } else {
            entry.removed = true;
            entry.compressed = '';
          }
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

/**
 * Update source map entries with what a single stage did: which segments it
 * changed, which it removed, and which it introduced.
 */
function recordStageProvenance(
  sourceMap: SourceMapEntry[],
  before: PromptSegment[],
  after: PromptSegment[],
  stageName: string,
): void {
  const beforeById = new Map(before.map(s => [s.id, s]));
  const afterById = new Map(after.map(s => [s.id, s]));

  for (const entry of sourceMap) {
    if (entry.removed) continue;
    const prev = beforeById.get(entry.segmentId);
    if (!prev) continue;
    const next = afterById.get(entry.segmentId);
    if (!next) {
      entry.removed = true;
      entry.removedBy = stageName;
      entry.compressed = '';
    } else if (next.content !== prev.content) {
      entry.changedBy.push(stageName);
    }
  }

  // Segments this stage introduced (ids not present before it ran)
  const tracked = new Set(sourceMap.map(e => e.segmentId));
  for (const seg of after) {
    if (!beforeById.has(seg.id) && !tracked.has(seg.id)) {
      sourceMap.push({
        segmentId: seg.id,
        original: '',
        compressed: seg.content,
        changedBy: [],
        addedBy: stageName,
      });
    }
  }
}

/**
 * Recombine locked and mutable segments in original input order.
 * Uses segment IDs to map back to the correct position.
 *
 * A stage's structural decisions are honored: a segment absent from the final
 * mutable set is excluded from the output (not resurrected), and segments a
 * stage introduced (ids not present in the input) are appended at the end.
 */
function recombineSegments(
  original: PromptSegment[],
  locked: PromptSegment[],
  mutable: PromptSegment[],
  logger: PipelineLogger,
): PromptSegment[] {
  const lockedMap = new Map(locked.map(s => [s.id, s]));
  const mutableMap = new Map(mutable.map(s => [s.id, s]));
  const originalIds = new Set(original.map(s => s.id));

  const output: PromptSegment[] = [];
  for (const orig of original) {
    if (orig.locked) {
      output.push(lockedMap.get(orig.id) ?? orig);
      continue;
    }
    const seg = mutableMap.get(orig.id);
    if (seg) {
      output.push(seg);
    } else {
      logger.debug?.(`segment "${orig.id}" was removed by a stage and is excluded from output`);
    }
  }

  for (const seg of mutable) {
    if (!originalIds.has(seg.id)) {
      logger.debug?.(`segment "${seg.id}" was introduced by a stage and appended to output`);
      output.push(seg);
    }
  }

  return output;
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
