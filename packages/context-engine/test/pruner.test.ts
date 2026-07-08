import { describe, it, expect } from 'vitest';
import { pruneByScore, createPruningStage } from '../src/pruning/pruner.js';
import type { ScoredToken, TokenScorer } from '../src/pruning/types.js';
import type { PromptSegment, BudgetConfig } from '../src/pipeline/types.js';
import { DefaultTokenCounter } from '../src/providers/defaults.js';

const counter = new DefaultTokenCounter();

function makeSegment(id: string, content: string): PromptSegment {
  return { id, content, role: 'memory', priority: 1, locked: false };
}

function makeScored(text: string, score: number, offset: number): ScoredToken {
  return { text, score, offset };
}

describe('pruneByScore', () => {
  it('keeps highest-scored tokens within budget', () => {
    const tokens = [
      makeScored('important', 0.9, 0),
      makeScored(' ', 0.5, 1),
      makeScored('filler', 0.1, 2),
      makeScored(' ', 0.5, 3),
      makeScored('critical', 0.95, 4),
    ];

    const result = pruneByScore(tokens, 6, counter); // budget fits top 2 words + space
    expect(result).toContain('critical');
    expect(result).toContain('important');
    expect(result).not.toContain('filler');
  });

  it('preserves original order after selection', () => {
    const tokens = [
      makeScored('first', 0.8, 0),
      makeScored(' ', 0.5, 1),
      makeScored('middle', 0.3, 2),
      makeScored(' ', 0.5, 3),
      makeScored('last', 0.9, 4),
    ];

    const result = pruneByScore(tokens, 5, counter);
    const firstIdx = result.indexOf('first');
    const lastIdx = result.indexOf('last');
    expect(firstIdx).toBeLessThan(lastIdx);
  });

  it('returns empty string for empty input', () => {
    expect(pruneByScore([], 100, counter)).toBe('');
  });

  it('returns empty string for zero budget', () => {
    const tokens = [
      makeScored('hello', 0.9, 0),
      makeScored(' ', 0.5, 1),
      makeScored('world', 0.9, 2),
    ];
    const result = pruneByScore(tokens, 0, counter);
    expect(result).toBe('');
  });

  it('returns all tokens when budget is sufficient', () => {
    const tokens = [
      makeScored('hello', 0.5, 0),
      makeScored(' ', 0.5, 1),
      makeScored('world', 0.5, 2),
    ];

    const result = pruneByScore(tokens, 1000, counter);
    expect(result).toBe('hello world');
  });

  it('respects token counter for budget', () => {
    const longWord = 'a'.repeat(100);
    const tokens = [
      makeScored(longWord, 0.9, 0),
      makeScored(' ', 0.5, 1),
      makeScored('short', 0.8, 2),
    ];

    // Budget of 5 tokens — should only fit 'short'
    const result = pruneByScore(tokens, 5, counter);
    expect(result).toBe('short');
  });

  it('always keeps protected tokens even when they lose on score and budget', () => {
    // A low-scored but protected token (e.g. a negation) must survive even
    // under a budget too tight to hold everything.
    const tokens: ScoredToken[] = [
      makeScored('delete', 0.9, 0),
      makeScored(' ', 0.5, 1),
      { text: 'not', score: 0.1, offset: 2, protected: true },
    ];
    // Budget nominally fits only the high-scored 'delete', but 'not' is kept.
    const result = pruneByScore(tokens, 1, counter);
    expect(result).toContain('not');
  });
});

describe('createPruningStage', () => {
  // Simple scorer: words longer than 4 chars score high, others low
  const simpleScorer: TokenScorer = {
    score(content: string) {
      const parts = content.split(/(\s+)/);
      return parts.map((text, i) => ({
        text,
        score: text.trim().length > 4 ? 0.9 : 0.2,
        offset: i,
      }));
    },
  };

  it('reduces segment content when over budget', () => {
    const stage = createPruningStage(simpleScorer);
    const verbose = 'The very important research findings indicate that we should proceed';
    const segments = [makeSegment('a', verbose)];
    const context = {
      tokenCounter: counter,
      budget: { maxTokens: 5, outputReserve: 0 } as BudgetConfig,
    };

    const result = stage.execute(segments, context);
    const outputTokens = counter.countTokens(result.segments[0].content);
    const inputTokens = counter.countTokens(verbose);
    expect(outputTokens).toBeLessThan(inputTokens);
  });

  it('passes through segments already within budget', () => {
    const stage = createPruningStage(simpleScorer);
    const short = 'hello';
    const segments = [makeSegment('a', short)];
    const context = {
      tokenCounter: counter,
      budget: { maxTokens: 1000, outputReserve: 0 } as BudgetConfig,
    };

    const result = stage.execute(segments, context);
    expect(result.segments[0].content).toBe(short);
  });
});
