/**
 * Circuit Breaker
 *
 * Wraps a compression stage and dynamically bypasses it when the
 * latency cost exceeds the token savings benefit. Prevents ML-heavy
 * stages from slowing down the pipeline when they aren't paying
 * for themselves.
 *
 * @module budget/circuit-breaker
 */

import type { CompressionStage, PromptSegment, StageContext } from '../pipeline/types.js';
import type { LatencyTracker } from './latency-tracker.js';

export interface CircuitBreakerOptions {
  /** Minimum tokens saved per millisecond to keep the stage active (default 1.0). */
  minEfficiency?: number;
  /** Run at least N times before considering bypass (default 5). */
  warmupSamples?: number;
  /** After bypassing, retry after this many milliseconds (default 30000). */
  cooldownMs?: number;
}

/**
 * Wrap a compression stage with a circuit breaker.
 *
 * Behavior:
 * 1. During warmup (first N calls): always execute, collecting data
 * 2. After warmup: check efficiency. If below threshold, skip
 * 3. After cooldown period: retry one call to re-evaluate
 *
 * @param stage - The stage to wrap.
 * @param tracker - Latency tracker for efficiency data.
 * @param options - Circuit breaker configuration.
 * @returns A wrapped stage that may bypass the inner stage.
 */
export function createCircuitBreaker(
  stage: CompressionStage,
  tracker: LatencyTracker,
  options?: CircuitBreakerOptions,
): CompressionStage {
  const minEfficiency = options?.minEfficiency ?? 1.0;
  const warmupSamples = options?.warmupSamples ?? 5;
  const cooldownMs = options?.cooldownMs ?? 30_000;

  let bypassingSince: number | null = null;

  return {
    name: `circuit-breaker:${stage.name}`,
    // Propagate the wrapped stage's scope — dropping it would misclassify a
    // cross-segment stage as per-segment in the incremental pipeline.
    scope: stage.scope,
    execute(segments: PromptSegment[], context: StageContext) {
      const stats = tracker.getAverage(stage.name);

      // Warmup: always execute to collect data
      if (stats.samplesCount < warmupSamples) {
        return executeAndTrack(stage, segments, context, tracker);
      }

      // Check efficiency
      const efficiency = tracker.getEfficiency(stage.name);
      if (efficiency >= minEfficiency) {
        bypassingSince = null;
        return executeAndTrack(stage, segments, context, tracker);
      }

      // Efficiency too low — enter or continue bypass mode
      const now = Date.now();
      if (bypassingSince === null) {
        // First bypass — start the clock
        bypassingSince = now;
        return { segments };
      }

      if (now - bypassingSince >= cooldownMs) {
        // Cooldown elapsed — retry once to re-evaluate
        bypassingSince = now;
        return executeAndTrack(stage, segments, context, tracker);
      }

      // Still in bypass mode
      return { segments };
    },
  };
}

function executeAndTrack(
  stage: CompressionStage,
  segments: PromptSegment[],
  context: StageContext,
  tracker: LatencyTracker,
): { segments: PromptSegment[] } {
  const tokensBefore = countAllTokens(segments, context);
  const start = performance.now();

  try {
    const result = stage.execute(segments, context);
    const durationMs = performance.now() - start;
    const tokensAfter = countAllTokens(result.segments, context);
    const tokensSaved = tokensBefore - tokensAfter;

    tracker.record(stage.name, durationMs, tokensSaved);

    return result;
  } catch {
    // Record the failed attempt with zero savings so the circuit breaker learns
    const durationMs = performance.now() - start;
    tracker.record(stage.name, durationMs, 0);

    // Pass through unchanged (graceful degradation)
    return { segments };
  }
}

function countAllTokens(segments: PromptSegment[], context: StageContext): number {
  let total = 0;
  for (const seg of segments) {
    total += context.tokenCounter.countTokens(seg.content, context.model);
  }
  return total;
}
