/**
 * Tests for the generic score-based pruner and its pipeline stage
 * (src/pruning/pruner.ts).
 */

import { describe, it, expect } from 'vitest';
import { pruneByScore, createPruningStage } from '../src/pruning/pruner.js';
import type { ScoredToken, TokenScorer } from '../src/pruning/types.js';
import type { BudgetConfig, StageContext } from '../src/pipeline/types.js';
import { DefaultTokenCounter } from '../src/providers/defaults.js';
import { seg, makeContext } from './helpers.js';

const counter = new DefaultTokenCounter();

function makeScored(text: string, score: number, offset: number): ScoredToken {
  return { text, score, offset };
}

describe('pruneByScore', () => {
  it('keeps the highest-scored tokens within budget', () => {
    const tokens = [
      makeScored('important', 0.9, 0),
      makeScored(' ', 0.5, 1),
      makeScored('filler', 0.1, 2),
      makeScored(' ', 0.5, 3),
      makeScored('critical', 0.95, 4),
    ];

    const result = pruneByScore(tokens, 6, counter);

    expect(result).toContain('critical');
    expect(result).toContain('important');
    expect(result).not.toContain('filler');
  });

  it('restores original order after score-based selection', () => {
    const tokens = [
      makeScored('first', 0.8, 0),
      makeScored(' ', 0.5, 1),
      makeScored('middle', 0.3, 2),
      makeScored(' ', 0.5, 3),
      makeScored('last', 0.9, 4),
    ];

    const result = pruneByScore(tokens, 5, counter);

    expect(result.indexOf('first')).toBeLessThan(result.indexOf('last'));
  });

  it('returns an empty string for empty input', () => {
    expect(pruneByScore([], 100, counter)).toBe('');
  });

  it('returns an empty string for a zero budget', () => {
    const tokens = [makeScored('hello', 0.9, 0), makeScored(' ', 0.5, 1), makeScored('world', 0.9, 2)];

    expect(pruneByScore(tokens, 0, counter)).toBe('');
  });

  it('returns all tokens when the budget is sufficient', () => {
    const tokens = [makeScored('hello', 0.5, 0), makeScored(' ', 0.5, 1), makeScored('world', 0.5, 2)];

    expect(pruneByScore(tokens, 1000, counter)).toBe('hello world');
  });

  it('charges each token against the injected token counter', () => {
    const tokens = [
      makeScored('a'.repeat(100), 0.9, 0),
      makeScored(' ', 0.5, 1),
      makeScored('short', 0.8, 2),
    ];

    expect(pruneByScore(tokens, 5, counter)).toBe('short');
  });

  it('keeps a protected token that loses on both score and budget', () => {
    const tokens: ScoredToken[] = [
      makeScored('delete', 0.9, 0),
      makeScored(' ', 0.5, 1),
      { text: 'not', score: 0.1, offset: 2, protected: true },
    ];

    expect(pruneByScore(tokens, 1, counter)).toContain('not');
  });
});

describe('createPruningStage', () => {
  const simpleScorer: TokenScorer = {
    score(content: string) {
      return content.split(/(\s+)/).map((text, i) => ({
        text,
        score: text.trim().length > 4 ? 0.9 : 0.2,
        offset: i,
      }));
    },
  };

  it('declares cross-segment scope', () => {
    expect(createPruningStage(simpleScorer).scope).toBe('cross-segment');
  });

  it('reduces a prose segment that is over budget', () => {
    const verbose = 'The very important research findings indicate that we should proceed';

    const result = createPruningStage(simpleScorer).execute(
      [seg('a', verbose, 'history')],
      makeContext({ maxTokens: 5, tokenCounter: counter }),
    );

    expect(counter.countTokens(result.segments[0].content)).toBeLessThan(counter.countTokens(verbose));
  });

  it('passes through a segment already within budget', () => {
    const short = 'hello';

    const result = createPruningStage(simpleScorer).execute(
      [seg('a', short, 'history')],
      makeContext({ maxTokens: 1000, tokenCounter: counter }),
    );

    expect(result.segments[0].content).toBe(short);
  });

  it('respects an explicit per-segment budget over the proportional share', () => {
    const verbose = 'The very important research findings indicate that we should proceed';

    const result = createPruningStage(simpleScorer).execute(
      [seg('a', verbose, 'history')],
      makeContext({ maxTokens: 1000, segmentBudgets: { a: 2 }, tokenCounter: counter }),
    );

    expect(counter.countTokens(result.segments[0].content)).toBeLessThan(counter.countTokens(verbose));
  });

  it('passes empty segments through when the total token count is zero', () => {
    const result = createPruningStage(simpleScorer).execute(
      [seg('a', '', 'history'), seg('b', '', 'history')],
      makeContext({ maxTokens: 100, tokenCounter: counter }),
    );

    expect(result.segments.map(s => s.content)).toEqual(['', '']);
  });

  it('treats an unset outputReserve as zero when computing the budget', () => {
    const verbose = 'The very important research findings indicate that we should proceed';
    const context: StageContext = {
      tokenCounter: counter,
      budget: { maxTokens: 5 } as BudgetConfig,
    };

    const result = createPruningStage(simpleScorer).execute([seg('a', verbose, 'history')], context);

    expect(counter.countTokens(result.segments[0].content)).toBeLessThan(counter.countTokens(verbose));
  });

  it('leaves an over-budget structured memory segment intact', () => {
    const json = '{"score": 5, "fact_id": "abc123", "content": "a fairly long verbose memory value that exceeds budget"}';

    const result = createPruningStage(simpleScorer).execute(
      [seg('m', json, 'memory')],
      makeContext({ maxTokens: 3, tokenCounter: counter }),
    );

    expect(result.segments[0].content).toBe(json);
    expect(() => JSON.parse(result.segments[0].content)).not.toThrow();
  });

  it('protects JSON content even in a non-structured role', () => {
    const json = '{"a": "some long value here that will be over the tiny budget", "b": 2}';

    const result = createPruningStage(simpleScorer).execute(
      [seg('c', json, 'custom')],
      makeContext({ maxTokens: 2, tokenCounter: counter }),
    );

    expect(result.segments[0].content).toBe(json);
    expect(() => JSON.parse(result.segments[0].content)).not.toThrow();
  });
});
