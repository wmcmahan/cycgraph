/**
 * Tiktoken Adapter
 *
 * Optional provider adapter that wraps a BPE encode function
 * (from `gpt-tokenizer` or similar) into a `TokenCounter`.
 *
 * Usage:
 * ```ts
 * import { encode } from 'gpt-tokenizer';
 * import { createTiktokenCounter } from '@cycgraph/context-engine';
 *
 * const counter = createTiktokenCounter(encode);
 * ```
 *
 * @module providers/tiktoken-adapter
 */

import type { TokenCounter } from './types.js';

/**
 * Create a TokenCounter that uses an external BPE encode function.
 *
 * The encode function must take a string and return an array of token IDs.
 * This adapter counts the length of that array.
 *
 * Counts are memoized (LRU, bounded by entry count): the pipeline re-counts
 * every segment at every stage boundary, so unchanged content would otherwise
 * be re-encoded N-stages times per turn.
 *
 * @param encode - BPE encode function (e.g., from `gpt-tokenizer`).
 * @param options.cacheSize - Max memoized texts (default 512; 0 disables).
 * @returns A TokenCounter using exact BPE tokenization.
 */
export function createTiktokenCounter(
  encode: (text: string) => number[],
  options?: { cacheSize?: number },
): TokenCounter {
  const cacheSize = options?.cacheSize ?? 512;
  const cache = new Map<string, number>();

  return {
    countTokens(text: string): number {
      if (text.length === 0) return 0;
      if (cacheSize <= 0) return encode(text).length;

      const hit = cache.get(text);
      if (hit !== undefined) {
        // Refresh recency — Map iteration order is insertion order
        cache.delete(text);
        cache.set(text, hit);
        return hit;
      }

      const count = encode(text).length;
      cache.set(text, count);
      if (cache.size > cacheSize) {
        cache.delete(cache.keys().next().value!);
      }
      return count;
    },
  };
}
