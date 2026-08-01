/**
 * Tests for the n-gram surprisal token scorer (src/pruning/ngram-scorer.ts).
 */

import { describe, it, expect } from 'vitest';
import { createNGramScorer } from '../src/pruning/ngram-scorer.js';

const nonWhitespace = (t: { text: string }) => t.text.trim().length > 0;

describe('createNGramScorer', () => {
  const scorer = createNGramScorer();

  it('returns an empty array for empty content', () => {
    expect(scorer.score('')).toEqual([]);
  });

  it('scores a lone token 0.5 because there is nothing to normalize against', () => {
    const nonWs = scorer.score('hello').filter(nonWhitespace);

    expect(nonWs).toHaveLength(1);
    expect(nonWs[0].score).toBe(0.5);
  });

  it('keeps every score within [0,1]', () => {
    const result = scorer.score('the quick brown fox jumps over the lazy dog');

    for (const token of result) {
      expect(token.score).toBeGreaterThanOrEqual(0);
      expect(token.score).toBeLessThanOrEqual(1);
    }
  });

  it('scores a rare token above the surrounding boilerplate', () => {
    const result = scorer.score('the the the the the the xylophone the the the');

    const theToken = result.find(t => t.text === 'the')!;
    const rareToken = result.find(t => t.text === 'xylophone')!;
    expect(rareToken.score).toBeGreaterThan(theToken.score);
  });

  it('gives identical repeated tokens identical scores', () => {
    const nonWs = scorer.score('aaa aaa aaa aaa').filter(nonWhitespace);

    const uniqueScores = new Set(nonWs.map(t => t.score));
    expect(uniqueScores.size).toBe(1);
  });

  it('preserves offset ordering', () => {
    const result = scorer.score('alpha beta gamma');

    result.forEach((token, i) => expect(token.offset).toBe(i));
  });

  it('splits into whitespace-delimited units at token granularity', () => {
    const result = createNGramScorer({ granularity: 'token' }).score('hello world foo');

    expect(result.filter(nonWhitespace)).toHaveLength(3);
  });

  it('splits on comma/semicolon boundaries at phrase granularity', () => {
    const result = createNGramScorer({ granularity: 'phrase' }).score('hello world, foo bar; baz qux');

    expect(result.filter(nonWhitespace).length).toBeGreaterThanOrEqual(3);
  });

  it('splits on sentence boundaries at sentence granularity', () => {
    const result = createNGramScorer({ granularity: 'sentence' }).score('First sentence. Second sentence. Third one.');

    expect(result).toHaveLength(3);
  });

  it('drops the empty trailing unit left by whitespace after a final sentence', () => {
    const result = createNGramScorer({ granularity: 'sentence' }).score('First idea. Second idea. ');

    expect(result).toHaveLength(2);
    expect(result.every(t => t.text.length > 0)).toBe(true);
  });

  it('produces normalized scores with n=2 bigrams', () => {
    const nonWs = createNGramScorer({ n: 2 }).score('the quick brown fox').filter(nonWhitespace);

    expect(nonWs.length).toBeGreaterThan(0);
    expect(nonWs.every(t => t.score >= 0 && t.score <= 1)).toBe(true);
  });

  it('produces normalized scores with n=4 four-grams', () => {
    const nonWs = createNGramScorer({ n: 4 }).score('the quick brown fox').filter(nonWhitespace);

    expect(nonWs.length).toBeGreaterThan(0);
    expect(nonWs.every(t => t.score >= 0 && t.score <= 1)).toBe(true);
  });

  it('scores the same token count for different n', () => {
    const content = 'the quick brown fox jumps over lazy';
    const biScores = createNGramScorer({ n: 2 }).score(content).filter(nonWhitespace);
    const triScores = createNGramScorer({ n: 3 }).score(content).filter(nonWhitespace);

    expect(biScores.length).toBe(triScores.length);
    expect(biScores.length).toBeGreaterThan(0);
    for (const t of [...biScores, ...triScores]) {
      expect(t.score).toBeGreaterThanOrEqual(0);
      expect(t.score).toBeLessThanOrEqual(1);
    }
  });

  it('ranks a token as rarer when the corpus makes its neighbours common', () => {
    const content = 'xylophone plays music';
    const withCorpus = scorer.score(content, {
      allContent: [
        'plays music all day',
        'plays music all night',
        'plays music every time',
        'plays music nonstop',
        content,
      ],
    });

    const xylo = withCorpus.find(t => t.text === 'xylophone')!;
    const plays = withCorpus.find(t => t.text === 'plays')!;
    expect(xylo.score).toBeGreaterThan(plays.score);
  });

  it('falls back to the input as its own corpus when allContent is empty', () => {
    expect(scorer.score('hello world', { allContent: [] }).length).toBeGreaterThan(0);
  });

  it('falls back to the input as its own corpus when context is undefined', () => {
    expect(scorer.score('hello world').length).toBeGreaterThan(0);
  });

  it('widens the score range as smoothing decreases', () => {
    const content = 'the quick brown fox jumps';
    const lowScores = createNGramScorer({ smoothing: 0.01 }).score(content).filter(nonWhitespace);
    const highScores = createNGramScorer({ smoothing: 100 }).score(content).filter(nonWhitespace);

    const range = (ts: { score: number }[]) =>
      Math.max(...ts.map(t => t.score)) - Math.min(...ts.map(t => t.score));
    expect(range(lowScores)).toBeGreaterThanOrEqual(range(highScores) - 0.001);
  });

  it('scores whitespace tokens within [0,1]', () => {
    const ws = scorer.score('hello   world').find(t => t.text.trim() === '' && t.text.length > 0)!;

    expect(ws.score).toBeGreaterThanOrEqual(0);
    expect(ws.score).toBeLessThanOrEqual(1);
  });

  it('scores tokens shorter than the n-gram size', () => {
    const iToken = scorer.score('I am a dog').find(t => t.text === 'I')!;

    expect(iToken.score).toBeGreaterThanOrEqual(0);
  });

  it('scores a very large input without a stack overflow', () => {
    const tokenScorer = createNGramScorer({ granularity: 'token' });
    const huge = 'word '.repeat(200_000);

    const result = tokenScorer.score(huge);

    expect(result.length).toBeGreaterThan(100_000);
  });
});
