/**
 * N-Gram Surprisal Token Scorer
 *
 * Estimates token importance via character trigram (or n-gram) statistics.
 * Tokens with rare character n-grams have higher self-information (surprisal)
 * and score higher, while tokens composed of common n-grams score lower.
 *
 * No ML required — pure character-level frequency analysis.
 *
 * @module pruning/ngram-scorer
 */

import type { ScoredToken, TokenScorer, ScorerContext } from './types.js';
import type { Granularity } from './self-information.js';

export interface NGramScorerOptions {
  /** N-gram size (default 3 for character trigrams). */
  n?: number;
  /** Laplace smoothing factor (default 1). */
  smoothing?: number;
  /** Scoring granularity (default 'token'). */
  granularity?: Granularity;
}

/**
 * Create an n-gram surprisal scorer.
 *
 * Algorithm:
 * 1. Build character n-gram frequency model from all segment content (corpus).
 * 2. For each token, compute average n-gram log-probability with Laplace smoothing.
 * 3. Normalize scores to [0,1] via min-max across the segment.
 */
export function createNGramScorer(options?: NGramScorerOptions): TokenScorer {
  const n = options?.n ?? 3;
  const smoothing = options?.smoothing ?? 1;
  const granularity = options?.granularity ?? 'token';

  return {
    score(content: string, context?: ScorerContext): ScoredToken[] {
      if (content.length === 0) return [];

      // Build corpus from context or just the input
      const corpusParts =
        context?.allContent && context.allContent.length > 0
          ? context.allContent
          : [content];

      // Build n-gram frequency model from corpus
      const { freqMap, totalNgrams, vocabularySize } = buildNgramModel(corpusParts, n);

      // Split content into units
      const units = splitByGranularity(content, granularity);
      if (units.length === 0) return [];

      // Score each unit by average n-gram surprisal
      const rawScores: number[] = units.map(unit => {
        const ngrams = extractCharNgrams(unit.text, n);
        if (ngrams.length === 0) return 0;

        let totalSurprisal = 0;
        for (const ng of ngrams) {
          const count = freqMap.get(ng) ?? 0;
          const prob = (count + smoothing) / (totalNgrams + smoothing * vocabularySize);
          totalSurprisal += -Math.log2(prob);
        }
        return totalSurprisal / ngrams.length;
      });

      // Min-max normalize to [0,1]. Compute with a loop, NOT Math.min(...spread)
      // — at token granularity `rawScores` can hold hundreds of thousands of
      // entries, and spreading that many args overflows the call stack (turning
      // the pruner into a silent passthrough on exactly its largest inputs).
      let min = Infinity;
      let max = -Infinity;
      for (const s of rawScores) {
        if (s < min) min = s;
        if (s > max) max = s;
      }

      const scored: ScoredToken[] = units.map((unit, i) => ({
        text: unit.text,
        score: max === min ? 0.5 : (rawScores[i] - min) / (max - min),
        offset: unit.offset,
      }));

      return scored;
    },
  };
}

// ─── N-Gram Model ─────────────────────────────────────────────────

interface NgramModel {
  freqMap: Map<string, number>;
  totalNgrams: number;
  vocabularySize: number;
}

function buildNgramModel(corpusParts: string[], n: number): NgramModel {
  const freqMap = new Map<string, number>();
  let totalNgrams = 0;

  for (const text of corpusParts) {
    const ngrams = extractCharNgrams(text, n);
    for (const ng of ngrams) {
      freqMap.set(ng, (freqMap.get(ng) ?? 0) + 1);
      totalNgrams++;
    }
  }

  return { freqMap, totalNgrams, vocabularySize: freqMap.size };
}

function extractCharNgrams(text: string, n: number): string[] {
  if (text.length < n) return text.length > 0 ? [text] : [];
  const ngrams: string[] = [];
  for (let i = 0; i <= text.length - n; i++) {
    ngrams.push(text.substring(i, i + n));
  }
  return ngrams;
}

// ─── Granularity Splitting (mirrored from self-information.ts) ────

interface TextUnit {
  text: string;
  offset: number;
}

function splitByGranularity(content: string, granularity: Granularity): TextUnit[] {
  switch (granularity) {
    case 'token':
      return splitTokens(content);
    case 'phrase':
      return splitPhrases(content);
    case 'sentence':
      return splitSentences(content);
  }
}

function splitTokens(content: string): TextUnit[] {
  const parts = content.split(/(\s+)/);
  return parts.map((text, offset) => ({ text, offset }));
}

function splitPhrases(content: string): TextUnit[] {
  const parts = content.split(/([,;]\s*)/);
  return parts.map((text, offset) => ({ text, offset }));
}

function splitSentences(content: string): TextUnit[] {
  const parts = content.split(/(?<=[.!?])\s+/);
  const units: TextUnit[] = [];
  let offset = 0;
  for (const part of parts) {
    if (part.length > 0) {
      units.push({ text: part, offset });
      offset++;
    }
  }
  return units;
}
