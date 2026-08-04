/**
 * stats — descriptive statistics
 *
 * Count, sum, mean, median, min, max, sample standard deviation, and
 * linearly interpolated percentiles over an array of finite numbers. Pure,
 * untainted, deterministic.
 *
 * @module data/stats
 */

import { z } from 'zod';
import { defineTool, type DefinedTool } from '@cycgraph/orchestrator';

/** Options for {@link createStatsTool}. */
export interface StatsToolOptions {
  /** Per-call timeout forwarded to defineTool. @default 5000 */
  timeoutMs?: number;
}

/** Linearly interpolated percentile over a sorted array (p in 0–100). */
function percentile(sorted: number[], p: number): number {
  const rank = (p / 100) * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  if (low === high) return sorted[low];
  return sorted[low] + (sorted[high] - sorted[low]) * (rank - low);
}

/**
 * Create the `stats` tool.
 */
export function createStatsTool(options: StatsToolOptions = {}): DefinedTool {
  return defineTool({
    name: 'stats',
    description:
      'Compute descriptive statistics over an array of numbers: count, sum, mean, ' +
      'median, min, max, sample standard deviation, and p25/p75/p95 percentiles.',
    parameters: z.object({
      values: z
        .array(z.number().finite())
        .min(1)
        .max(100_000)
        .describe('The numbers to summarize'),
    }),
    timeoutMs: options.timeoutMs ?? 5_000,
    execute: ({ values }) => {
      const sorted = [...values].sort((a, b) => a - b);
      const count = sorted.length;
      const sum = sorted.reduce((acc, v) => acc + v, 0);
      const mean = sum / count;
      const variance =
        count > 1
          ? sorted.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (count - 1)
          : 0;

      return {
        count,
        sum,
        mean,
        median: percentile(sorted, 50),
        min: sorted[0],
        max: sorted[count - 1],
        stdDev: Math.sqrt(variance),
        p25: percentile(sorted, 25),
        p75: percentile(sorted, 75),
        p95: percentile(sorted, 95),
      };
    },
  });
}
