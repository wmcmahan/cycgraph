/**
 * Generic Score-Based Pruner
 *
 * Given scored tokens and a budget, selects the most important tokens
 * that fit within the budget while preserving original order.
 *
 * @module pruning/pruner
 */

import type { TokenCounter } from '../providers/types.js';
import type { CompressionStage, PromptSegment, StageContext } from '../pipeline/types.js';
import type { ScoredToken, TokenScorer, ScorerContext } from './types.js';

/**
 * Prune scored tokens to fit within a token budget.
 *
 * Algorithm:
 * 1. Always keep `protected` tokens (e.g. negations) — never budget-dropped
 * 2. Sort the rest by score descending (most important first)
 * 3. Greedily select tokens until budget is reached
 * 4. Re-sort selected tokens by original offset
 * 5. Join preserving whitespace structure
 */
export function pruneByScore(
  tokens: ScoredToken[],
  maxTokens: number,
  counter: TokenCounter,
  model?: string,
): string {
  if (tokens.length === 0) return '';

  // Protected tokens are kept unconditionally: dropping a negation ("not",
  // "never", …) inverts meaning, which is worse than slightly exceeding a
  // soft budget. They're selected first and their cost is charged up front.
  const selected: ScoredToken[] = [];
  let runningCount = 0;
  for (const token of tokens) {
    if (token.protected) {
      selected.push(token);
      runningCount += counter.countTokens(token.text, model);
    }
  }

  // Sort the remaining tokens by importance (highest first).
  const sorted = tokens
    .filter(t => !t.protected)
    .sort((a, b) => b.score - a.score);

  // Greedily select tokens within the remaining budget.
  // Track running token count incrementally to avoid O(n^2) re-counting.
  for (const token of sorted) {
    const tokenCount = counter.countTokens(token.text, model);
    if (runningCount + tokenCount <= maxTokens) {
      selected.push(token);
      runningCount += tokenCount;
    }
  }

  // Re-sort by original position
  selected.sort((a, b) => a.offset - b.offset);

  // Join — collapse excessive whitespace at gaps
  let result = '';
  let lastOffset = -1;

  for (const token of selected) {
    if (lastOffset >= 0 && token.offset > lastOffset + 1) {
      // Gap in offsets — ensure at least one space
      if (result.length > 0 && !result.endsWith(' ') && !result.endsWith('\n') && !token.text.startsWith(' ') && !token.text.startsWith('\n')) {
        result += ' ';
      }
    }
    result += token.text;
    lastOffset = token.offset;
  }

  return result.trim();
}

/**
 * Segment roles whose content is structured data (serialized memory,
 * tool/JSON schemas) rather than prose. Token-level pruning drops
 * whitespace-delimited tokens — meaning-preserving lossy compression for prose,
 * but it CORRUPTS structured data: dropping a key, value, or delimiter yields
 * malformed output (e.g. `{"score": , "fact_id":"abc"}`) that the consuming LLM
 * silently misreads. Structured segments are compressed by structure-aware
 * stages (format, dedup) instead and are left intact by token pruning.
 */
const STRUCTURED_ROLES: ReadonlySet<string> = new Set(['memory', 'tools']);

/** Cheap safety-net for JSON content in a non-structured role (e.g. `custom`). */
function looksStructured(content: string): boolean {
  const t = content.trimStart();
  return t.startsWith('{') || t.startsWith('[');
}

/**
 * True when a segment must NOT be token-pruned because doing so would corrupt
 * structured content. Gates on role first (format-independent — survives the
 * format stage rewriting JSON into a compact non-JSON shape), with a JSON
 * content sniff as a backstop for structured data in an unexpected role.
 */
function isTokenPruneUnsafe(seg: PromptSegment): boolean {
  return STRUCTURED_ROLES.has(seg.role) || looksStructured(seg.content);
}

/**
 * Create a pipeline compression stage that prunes tokens by importance scores.
 *
 * For each segment, scores all tokens via the provided scorer, then
 * prunes to fit within the segment's share of the budget. Structured segments
 * (see {@link isTokenPruneUnsafe}) are passed through untouched — token pruning
 * is only applied to prose.
 */
export function createPruningStage(scorer: TokenScorer): CompressionStage {
  return {
    name: 'score-pruning',
    execute(segments: PromptSegment[], context: StageContext) {
      const totalBudget = context.budget.maxTokens - (context.budget.outputReserve ?? 0);
      const allContent = segments.map(s => s.content);

      // Distribute budget proportionally by current token count
      const counts = segments.map(s => context.tokenCounter.countTokens(s.content, context.model));
      const totalTokens = counts.reduce((a, b) => a + b, 0);

      const output = segments.map((seg, i) => {
        const segBudget = context.budget.segmentBudgets?.[seg.id]
          ?? (totalTokens > 0 ? Math.floor((counts[i] / totalTokens) * totalBudget) : totalBudget);

        // Skip if already within budget
        if (counts[i] <= segBudget) return seg;

        // Never token-prune structured content — it would corrupt it. Better to
        // leave a memory/tools segment slightly over its soft budget (the format
        // and dedup stages already compress it) than hand the model malformed
        // JSON.
        if (isTokenPruneUnsafe(seg)) return seg;

        const scorerContext: ScorerContext = {
          role: seg.role,
          allContent,
        };

        const scored = scorer.score(seg.content, scorerContext);
        const pruned = pruneByScore(scored, segBudget, context.tokenCounter, context.model);

        return { ...seg, content: pruned };
      });

      return { segments: output };
    },
  };
}
