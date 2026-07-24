/**
 * Shared token utilities for the benchmark.
 *
 * All adapters and budget math use the SAME counter so budgets mean the
 * same thing for every engine — fairness requires a common ruler, even an
 * approximate one. The counter choice affects absolute budgets, not the
 * relative comparison.
 *
 * @module bench/token-utils
 */

import { DefaultTokenCounter } from '@cycgraph/context-engine';

export const benchCounter = new DefaultTokenCounter();

/** Count tokens with the shared benchmark counter. */
export function countTokens(text: string): number {
  return benchCounter.countTokens(text);
}

/**
 * Cut text to a token budget at a character boundary (binary search).
 * Used by the naive truncation baselines.
 */
export function sliceToTokenBudget(text: string, budgetTokens: number, fromEnd = false): string {
  if (budgetTokens <= 0) return '';
  if (countTokens(text) <= budgetTokens) return text;

  let low = 0;
  let high = text.length;
  let best = 0;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const slice = fromEnd ? text.slice(text.length - mid) : text.slice(0, mid);
    if (countTokens(slice) <= budgetTokens) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return fromEnd ? text.slice(text.length - best) : text.slice(0, best);
}

/**
 * Deterministic PRNG (mulberry32). Benchmarks never use Math.random —
 * seeded randomness keeps runs reproducible.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a string hash for deriving per-question seeds. */
export function hashString(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 0x01000193) | 0;
  }
  return hash >>> 0;
}
