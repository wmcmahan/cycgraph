/**
 * Cache-Aware Prefix Locking
 *
 * Pre-processor that marks qualifying segments as locked to preserve
 * API prompt cache hits (Anthropic, OpenAI, local RadixAttention).
 * Locked segments bypass all compression stages, ensuring byte-identical
 * prefixes across calls.
 *
 * This is NOT a pipeline stage — the pipeline splits locked/mutable
 * before stages run. Apply this before `pipeline.compress()`.
 *
 * @module budget/cache-policy
 */

import type { PromptSegment } from '../pipeline/types.js';
import { fnv1a } from '../memory/dedup/exact.js';
import { resolveModelProfile } from '../routing/model-profiles.js';

export interface CachePolicyOptions {
  /** Lock segments with role 'system' (default true). */
  lockSystem?: boolean;
  /** Lock segments with role 'tools' (default true). */
  lockTools?: boolean;
  /** Lock the first N segments regardless of role (default 0). */
  lockFirstN?: number;
  /** Custom predicate for additional locking rules. */
  lockPredicate?: (segment: PromptSegment) => boolean;
  /**
   * Target model. When its profile says the provider has no prompt cache
   * (`supportsCaching: false`), the policy adds NO locks — locking trades
   * compression for cache stability, which buys nothing without a cache.
   * Pre-existing `locked` flags are always preserved. Omit to lock
   * unconditionally.
   */
  model?: string;
}

/**
 * Apply cache policy to segments, marking qualifying ones as locked.
 *
 * Returns new segment objects (does not mutate originals).
 *
 * @example
 * ```ts
 * const locked = applyCachePolicy(segments, { lockSystem: true, lockTools: true });
 * const result = pipeline.compress({ segments: locked, budget });
 * ```
 */
export function applyCachePolicy(
  segments: PromptSegment[],
  options?: CachePolicyOptions,
): PromptSegment[] {
  const lockSystem = options?.lockSystem ?? true;
  const lockTools = options?.lockTools ?? true;
  const lockFirstN = options?.lockFirstN ?? 0;
  const lockPredicate = options?.lockPredicate;

  // No provider prompt cache → locking has no benefit, only lost compression.
  const profile = resolveModelProfile(options?.model);
  if (profile && !profile.supportsCaching) {
    return segments;
  }

  return segments.map((seg, i) => {
    let shouldLock = seg.locked; // preserve existing locks

    if (!shouldLock && lockSystem && seg.role === 'system') shouldLock = true;
    if (!shouldLock && lockTools && seg.role === 'tools') shouldLock = true;
    if (!shouldLock && i < lockFirstN) shouldLock = true;
    if (!shouldLock && lockPredicate?.(seg)) shouldLock = true;

    return shouldLock !== seg.locked ? { ...seg, locked: shouldLock } : seg;
  });
}

/**
 * Compute FNV-1a hashes of segment contents for cross-turn cache stability.
 *
 * Compare hash sets between turns to measure cache hit rate:
 * `hitRate = intersection(current, previous).size / previous.size`
 */
export function computePrefixHashes(segments: PromptSegment[]): Set<number> {
  const hashes = new Set<number>();
  for (const seg of segments) {
    if (seg.locked) {
      hashes.add(fnv1a(seg.content));
    }
  }
  return hashes;
}

/**
 * Measure cache hit rate between two turns.
 *
 * Note: this is a set-based measure — the fraction of previously locked
 * content that is byte-identical this turn, ignoring position. Provider
 * prompt caches are prefix-based, so treat this as an upper bound: a changed
 * or reordered early segment can invalidate the cache for unchanged
 * segments after it.
 *
 * @returns Hit rate as 0-1 (1.0 = all previous locked segments are identical).
 */
export function measureCacheHitRate(
  current: Set<number>,
  previous: Set<number>,
): number {
  if (previous.size === 0) return 1.0;
  let hits = 0;
  for (const hash of previous) {
    if (current.has(hash)) hits++;
  }
  return hits / previous.size;
}

/**
 * Ordered list of locked-segment content hashes, in prompt order.
 * Input for {@link measurePrefixStability}.
 */
export function computePrefixHashList(segments: PromptSegment[]): number[] {
  const hashes: number[] = [];
  for (const seg of segments) {
    if (seg.locked) hashes.push(fnv1a(seg.content));
  }
  return hashes;
}

/**
 * Measure prefix stability between two turns: the fraction of the previous
 * turn's locked prefix that survives, in order, at the START of the current
 * one. This models provider prompt caches faithfully — a change or reorder
 * at position k invalidates everything from k on, however much later content
 * is byte-identical. Compare with {@link measureCacheHitRate}, the set-based
 * upper bound.
 *
 * @returns Stability as 0-1 (1.0 = previous prefix fully preserved).
 */
export function measurePrefixStability(current: number[], previous: number[]): number {
  if (previous.length === 0) return 1.0;
  let common = 0;
  const limit = Math.min(current.length, previous.length);
  while (common < limit && current[common] === previous[common]) common++;
  return common / previous.length;
}

/**
 * Compute a Map from segment ID to FNV-1a hash of segment content.
 * Useful for cross-turn cache stability diagnostics.
 */
export function computeSegmentHashMap(segments: PromptSegment[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const seg of segments) {
    map.set(seg.id, fnv1a(seg.content));
  }
  return map;
}
