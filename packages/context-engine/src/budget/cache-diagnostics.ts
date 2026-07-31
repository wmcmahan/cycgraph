/**
 * Cache Stability Diagnostics
 *
 * Compares segment hashes between turns to identify unstable segments
 * that break prompt cache hits. Provides actionable recommendations
 * for improving cache stability.
 *
 * @module budget/cache-diagnostics
 */

import type { PromptSegment } from '../pipeline/types.js';
import { fnv1a } from '../memory/dedup/exact.js';

export interface CacheDiagnostics {
  /** Fraction of comparable segments with stable hashes (0-1). */
  hitRate: number;
  /** Segments whose content changed between turns. */
  unstableSegments: Array<{ id: string; hashPrevious: number; hashCurrent: number }>;
  /** Actionable recommendations for improving cache stability. */
  recommendations: string[];
}

/**
 * Diagnose cache stability by comparing current segment hashes
 * against previous turn hashes.
 *
 * - Segments present in both turns with matching hashes are stable.
 * - New segments (not in previous) don't count toward hitRate.
 * - Removed segments (in previous, not current) don't count toward hitRate.
 * - If no segments are comparable (all new), hitRate = 1.0.
 */
export function diagnoseCacheStability(
  currentSegments: PromptSegment[],
  previousHashes: Map<string, number>,
): CacheDiagnostics {
  const unstableSegments: CacheDiagnostics['unstableSegments'] = [];
  const recommendations: string[] = [];

  let comparableCount = 0;
  let stableCount = 0;

  for (const seg of currentSegments) {
    const currentHash = fnv1a(seg.content);

    if (previousHashes.has(seg.id)) {
      comparableCount++;
      const previousHash = previousHashes.get(seg.id)!;

      if (currentHash === previousHash) {
        stableCount++;
      } else {
        unstableSegments.push({
          id: seg.id,
          hashPrevious: previousHash,
          hashCurrent: currentHash,
        });
        recommendations.push(
          `Segment '${seg.id}' with role '${seg.role}' changed between turns. Consider locking it or filtering dynamic content.`,
        );
      }
    }
  }

  const hitRate = comparableCount === 0 ? 1.0 : stableCount / comparableCount;

  return { hitRate, unstableSegments, recommendations };
}
