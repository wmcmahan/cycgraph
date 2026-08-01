/**
 * Latency Tracker
 *
 * Tracks rolling average latency and token savings per pipeline stage.
 * Used by the circuit breaker to decide when ML compression costs
 * more time than it saves in tokens.
 *
 * In-memory only — resets on restart. Latency characteristics change
 * with model load, hardware, and content type, so historical data
 * has limited value.
 *
 * @module budget/latency-tracker
 */

/** A single latency sample. */
interface LatencySample {
  durationMs: number;
  tokensSaved: number;
}

/** Rolling average stats for a stage. */
export interface LatencyStats {
  avgDurationMs: number;
  avgTokensSaved: number;
  samplesCount: number;
}

/** Latency tracker instance. */
export interface LatencyTracker {
  /** Record a latency sample for a stage. */
  record(stageName: string, durationMs: number, tokensSaved: number): void;
  /** Get rolling average stats for a stage. */
  getAverage(stageName: string): LatencyStats;
  /** Get efficiency ratio: tokens saved per millisecond. */
  getEfficiency(stageName: string): number;
  /** Reset all tracked data. */
  reset(): void;
}

/**
 * Create a latency tracker with a configurable rolling window.
 *
 * @param windowSize - Number of recent samples to keep per stage (default 100).
 */
export function createLatencyTracker(windowSize: number = 100): LatencyTracker {
  const samples = new Map<string, LatencySample[]>();

  return {
    record(stageName: string, durationMs: number, tokensSaved: number): void {
      const list = samples.get(stageName) ?? [];
      list.push({ durationMs, tokensSaved });

      if (list.length > windowSize) {
        list.splice(0, list.length - windowSize);
      }

      samples.set(stageName, list);
    },

    getAverage(stageName: string): LatencyStats {
      const list = samples.get(stageName);
      if (!list || list.length === 0) {
        return { avgDurationMs: 0, avgTokensSaved: 0, samplesCount: 0 };
      }

      const totalDuration = list.reduce((sum, s) => sum + s.durationMs, 0);
      const totalTokens = list.reduce((sum, s) => sum + s.tokensSaved, 0);

      return {
        avgDurationMs: totalDuration / list.length,
        avgTokensSaved: totalTokens / list.length,
        samplesCount: list.length,
      };
    },

    getEfficiency(stageName: string): number {
      const stats = this.getAverage(stageName);
      if (stats.avgDurationMs === 0) return 0;
      return stats.avgTokensSaved / stats.avgDurationMs;
    },

    reset(): void {
      samples.clear();
    },
  };
}
