/**
 * Self-Information Token Scorer
 *
 * Implements Selective Context / LLMLingua-style token importance
 * scoring via a `CompressionProvider`. Tokens with high self-information
 * (surprisal) are preserved; predictable tokens are pruned.
 *
 * Core math: I(t) = -log2 P(t | preceding_context)
 *
 * The provider handles actual model inference. This module handles
 * scoring orchestration, granularity modes, and pipeline integration.
 *
 * @module pruning/self-information
 */

import type { CompressionProvider } from '../providers/types.js';
import type { CompressionStage, PromptSegment } from '../pipeline/types.js';
import type { ScoredToken, TokenScorer, ScorerContext } from './types.js';
import { createPruningStage } from './pruner.js';
import { createNGramScorer } from './ngram-scorer.js';

export type Granularity = 'token' | 'phrase' | 'sentence';

export interface SelfInformationOptions {
  /** Compression provider for scoring (required for pre-computation). */
  provider?: CompressionProvider;
  /** Pre-computed scores keyed by segment content. */
  precomputed?: Map<string, ScoredToken[]>;
  /** Query string for contrastive scoring (LongLLMLingua-style). */
  query?: string;
  /** Scoring granularity (default: 'sentence'). */
  granularity?: Granularity;
  /** Fallback scorer when precomputed scores are unavailable (default: n-gram scorer). */
  fallbackScorer?: TokenScorer;
}

/**
 * Pre-compute importance scores for all segments using a CompressionProvider.
 * Call this async function before pipeline.compress().
 *
 * @param provider - The compression provider (e.g., local GPT-2).
 * @returns Map keyed by segment content (not id), so identical segments share
 *   one scoring pass.
 */
export async function precomputeImportanceScores(
  segments: PromptSegment[],
  provider: CompressionProvider,
  options?: { granularity?: Granularity; query?: string },
): Promise<Map<string, ScoredToken[]>> {
  const granularity = options?.granularity ?? 'sentence';
  const query = options?.query;
  const result = new Map<string, ScoredToken[]>();

  for (const seg of segments) {
    if (result.has(seg.content)) continue;

    const units = splitByGranularity(seg.content, granularity);
    const texts = units.map(u => u.text);
    const scores = await provider.scoreTokenImportance(texts, query);

    const scored: ScoredToken[] = units.map((unit, i) => ({
      text: unit.text,
      score: scores[i] ?? 0.5,
      offset: unit.offset,
    }));

    result.set(seg.content, scored);
  }

  return result;
}

/**
 * Create a sync TokenScorer that uses pre-computed importance scores.
 * Falls back to neutral 0.5 scores for content not in the pre-computed map.
 */
export function createSelfInformationScorer(options: SelfInformationOptions): TokenScorer {
  const precomputed = options.precomputed;
  const granularity = options.granularity ?? 'sentence';
  const fallback = options.fallbackScorer ?? createNGramScorer({ granularity });

  return {
    score(content: string, context?: ScorerContext): ScoredToken[] {
      if (precomputed?.has(content)) {
        return precomputed.get(content)!;
      }

      // Fallback: use n-gram scorer (or custom fallback) instead of uniform 0.5
      return fallback.score(content, context);
    },
  };
}

/**
 * Create a pipeline stage that prunes tokens by self-information scores.
 */
export function createSelfInformationStage(options: SelfInformationOptions): CompressionStage {
  const scorer = createSelfInformationScorer(options);
  const stage = createPruningStage(scorer);
  return { ...stage, name: 'self-information-pruning' };
}

// ─── Granularity Splitting ────────────────────────────────────────

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

/** Split into whitespace-separated tokens (preserving whitespace). */
function splitTokens(content: string): TextUnit[] {
  const parts = content.split(/(\s+)/);
  return parts.map((text, offset) => ({ text, offset }));
}

/** Split into simple phrase-like chunks (comma/semicolon boundaries). */
function splitPhrases(content: string): TextUnit[] {
  const parts = content.split(/([,;]\s*)/);
  return parts.map((text, offset) => ({ text, offset }));
}

/** Split into sentences. */
function splitSentences(content: string): TextUnit[] {
  // Split on sentence boundaries: period/exclamation/question followed by whitespace
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
