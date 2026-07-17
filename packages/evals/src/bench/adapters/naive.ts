/**
 * Naive Baseline Adapters
 *
 * The comparison floor every compression claim needs:
 *
 * - `none`            — no compression (the ceiling; ratio 1.0 only)
 * - `truncation-tail` — keep the prefix, cut the tail (what most callers do)
 * - `truncation-head` — keep the suffix, cut the head
 * - `random-drop`     — drop whitespace tokens uniformly at random (seeded
 *                       per question, reproducible) until within budget
 *
 * None of these use the question. If an engine can't beat truncation at
 * equal budgets, its intelligence isn't paying for itself.
 *
 * @module bench/adapters/naive
 */

import type { BenchQuestion, CompressorAdapter, CompressionOutput } from '../types.js';
import { countTokens, sliceToTokenBudget, mulberry32, hashString } from '../token-utils.js';

const VERSION = '1.0.0';

function joinContext(question: BenchQuestion): string {
  return question.documents.map(d => `${d.title}\n${d.text}`).join('\n\n');
}

function finish(compressed: string, start: number): CompressionOutput {
  return {
    compressed,
    outputTokens: countTokens(compressed),
    durationMs: performance.now() - start,
  };
}

export const noneAdapter: CompressorAdapter = {
  name: 'none',
  version: VERSION,
  async available() {
    return true;
  },
  async compress(question: BenchQuestion): Promise<CompressionOutput> {
    const start = performance.now();
    return finish(joinContext(question), start);
  },
};

export const truncationTailAdapter: CompressorAdapter = {
  name: 'truncation-tail',
  version: VERSION,
  async available() {
    return true;
  },
  async compress(question: BenchQuestion, budgetTokens: number): Promise<CompressionOutput> {
    const start = performance.now();
    return finish(sliceToTokenBudget(joinContext(question), budgetTokens), start);
  },
};

export const truncationHeadAdapter: CompressorAdapter = {
  name: 'truncation-head',
  version: VERSION,
  async available() {
    return true;
  },
  async compress(question: BenchQuestion, budgetTokens: number): Promise<CompressionOutput> {
    const start = performance.now();
    return finish(sliceToTokenBudget(joinContext(question), budgetTokens, true), start);
  },
};

export const randomDropAdapter: CompressorAdapter = {
  name: 'random-drop',
  version: VERSION,
  async available() {
    return true;
  },
  async compress(question: BenchQuestion, budgetTokens: number): Promise<CompressionOutput> {
    const start = performance.now();
    const context = joinContext(question);
    const words = context.split(/\s+/).filter(Boolean);
    const rng = mulberry32(hashString(question.id));

    // Shuffle indices (Fisher-Yates, seeded), then keep a prefix of the
    // shuffle large enough to fit the budget, restored to original order.
    const indices = words.map((_, i) => i);
    for (let i = indices.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [indices[i], indices[j]] = [indices[j], indices[i]];
    }

    let keepCount = words.length;
    let kept: string[] = words;
    while (keepCount > 0) {
      const keepSet = new Set(indices.slice(0, keepCount));
      kept = words.filter((_, i) => keepSet.has(i));
      if (countTokens(kept.join(' ')) <= budgetTokens) break;
      keepCount = Math.floor(keepCount * 0.9);
    }

    return finish(kept.join(' '), start);
  },
};
