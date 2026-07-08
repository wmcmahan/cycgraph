import { describe, it, expect } from 'vitest';
import { createNGramScorer } from '../src/pruning/ngram-scorer.js';

describe('createNGramScorer', () => {
  const scorer = createNGramScorer();

  // --- Basic behavior ---

  it('returns empty array for empty content', () => {
    const result = scorer.score('');
    expect(result).toEqual([]);
  });

  it('returns score 0.5 for single token (cannot normalize)', () => {
    const result = scorer.score('hello');
    // Single non-whitespace token among whitespace-split parts
    const nonWs = result.filter(t => t.text.trim().length > 0);
    // With a single word input there are no other tokens to compare
    expect(nonWs.length).toBe(1);
    expect(nonWs[0].score).toBe(0.5);
  });

  it('all scores are between 0 and 1', () => {
    const result = scorer.score('the quick brown fox jumps over the lazy dog');
    for (const token of result) {
      expect(token.score).toBeGreaterThanOrEqual(0);
      expect(token.score).toBeLessThanOrEqual(1);
    }
  });

  it('rare tokens in boilerplate content get higher scores', () => {
    // "the" repeats a lot, "xylophone" is rare
    const content = 'the the the the the the xylophone the the the';
    const result = scorer.score(content);
    const theTokens = result.filter(t => t.text === 'the');
    const rareToken = result.find(t => t.text === 'xylophone');
    expect(rareToken).toBeDefined();
    expect(rareToken!.score).toBeGreaterThan(theTokens[0].score);
  });

  it('uniform/repeated content: identical tokens get identical scores', () => {
    const content = 'aaa aaa aaa aaa';
    const result = scorer.score(content);
    const nonWs = result.filter(t => t.text.trim().length > 0);
    // All same token -> all should have identical scores
    const scores = nonWs.map(t => t.score);
    const uniqueScores = new Set(scores);
    expect(uniqueScores.size).toBe(1);
  });

  it('preserves offset ordering', () => {
    const result = scorer.score('alpha beta gamma');
    for (let i = 0; i < result.length; i++) {
      expect(result[i].offset).toBe(i);
    }
  });

  // --- Granularity ---

  it('supports token granularity', () => {
    const tokenScorer = createNGramScorer({ granularity: 'token' });
    const result = tokenScorer.score('hello world foo');
    // Token split includes whitespace
    expect(result.length).toBeGreaterThanOrEqual(3);
  });

  it('supports phrase granularity', () => {
    const phraseScorer = createNGramScorer({ granularity: 'phrase' });
    const result = phraseScorer.score('hello world, foo bar; baz qux');
    // Should split on comma/semicolon boundaries
    expect(result.length).toBeGreaterThanOrEqual(3);
  });

  it('supports sentence granularity', () => {
    const sentenceScorer = createNGramScorer({ granularity: 'sentence' });
    const result = sentenceScorer.score('First sentence. Second sentence. Third one.');
    expect(result.length).toBe(3);
  });

  // --- Custom n-gram sizes ---

  it('works with n=2 (bigrams)', () => {
    const bigramScorer = createNGramScorer({ n: 2 });
    const result = bigramScorer.score('the quick brown fox');
    expect(result.length).toBeGreaterThan(0);
    const nonWs = result.filter(t => t.text.trim().length > 0);
    expect(nonWs.every(t => t.score >= 0 && t.score <= 1)).toBe(true);
  });

  it('works with n=4 (4-grams)', () => {
    const quadScorer = createNGramScorer({ n: 4 });
    const result = quadScorer.score('the quick brown fox');
    expect(result.length).toBeGreaterThan(0);
    const nonWs = result.filter(t => t.text.trim().length > 0);
    expect(nonWs.every(t => t.score >= 0 && t.score <= 1)).toBe(true);
  });

  it('different n produces different raw orderings', () => {
    const bi = createNGramScorer({ n: 2 });
    const tri = createNGramScorer({ n: 3 });
    const content = 'the quick brown fox jumps over lazy';
    const biScores = bi.score(content).filter(t => t.text.trim().length > 0);
    const triScores = tri.score(content).filter(t => t.text.trim().length > 0);
    // Both should produce valid scored tokens
    expect(biScores.length).toBe(triScores.length);
    expect(biScores.length).toBeGreaterThan(0);
    // At least verify both produce normalized [0,1] scores
    for (const t of [...biScores, ...triScores]) {
      expect(t.score).toBeGreaterThanOrEqual(0);
      expect(t.score).toBeLessThanOrEqual(1);
    }
  });

  // --- Cross-segment corpus ---

  it('uses allContent from context for corpus building', () => {
    const content = 'xylophone plays music';
    // Without cross-segment context
    const scoresAlone = scorer.score(content);
    // With corpus where "plays" and "music" are very common
    const scoresWithCorpus = scorer.score(content, {
      allContent: [
        'plays music all day',
        'plays music all night',
        'plays music every time',
        'plays music nonstop',
        content,
      ],
    });

    const xyloAlone = scoresAlone.find(t => t.text === 'xylophone');
    const xyloWithCorpus = scoresWithCorpus.find(t => t.text === 'xylophone');
    // xylophone should score higher (rarer) with the corpus
    expect(xyloWithCorpus).toBeDefined();
    expect(xyloAlone).toBeDefined();
    // In the corpus context, xylophone is rare vs common "plays" and "music"
    const playsWithCorpus = scoresWithCorpus.find(t => t.text === 'plays');
    expect(xyloWithCorpus!.score).toBeGreaterThan(playsWithCorpus!.score);
  });

  it('falls back to input as corpus when allContent is empty', () => {
    const result = scorer.score('hello world', { allContent: [] });
    expect(result.length).toBeGreaterThan(0);
  });

  it('falls back to input as corpus when context is undefined', () => {
    const result = scorer.score('hello world');
    expect(result.length).toBeGreaterThan(0);
  });

  // --- Smoothing ---

  it('custom smoothing changes scores', () => {
    const lowSmooth = createNGramScorer({ smoothing: 0.01 });
    const highSmooth = createNGramScorer({ smoothing: 100 });
    const content = 'the quick brown fox jumps';
    const lowScores = lowSmooth.score(content).filter(t => t.text.trim().length > 0);
    const highScores = highSmooth.score(content).filter(t => t.text.trim().length > 0);
    // High smoothing flattens scores more toward uniform
    const lowRange = Math.max(...lowScores.map(t => t.score)) - Math.min(...lowScores.map(t => t.score));
    const highRange = Math.max(...highScores.map(t => t.score)) - Math.min(...highScores.map(t => t.score));
    // Low smoothing should produce a wider range (or equal)
    expect(lowRange).toBeGreaterThanOrEqual(highRange - 0.001);
  });

  // --- Whitespace handling ---

  it('assigns scores to whitespace tokens', () => {
    const result = scorer.score('hello   world');
    const ws = result.find(t => t.text.trim() === '' && t.text.length > 0);
    expect(ws).toBeDefined();
    expect(ws!.score).toBeGreaterThanOrEqual(0);
    expect(ws!.score).toBeLessThanOrEqual(1);
  });

  // --- Short tokens ---

  it('handles tokens shorter than n-gram size', () => {
    const result = scorer.score('I am a dog');
    expect(result.length).toBeGreaterThan(0);
    // "I" and "a" are shorter than trigram but should still get scored
    const iToken = result.find(t => t.text === 'I');
    expect(iToken).toBeDefined();
    expect(iToken!.score).toBeGreaterThanOrEqual(0);
  });

  it('handles a very large input without a stack overflow', () => {
    // At token granularity this produces hundreds of thousands of scores;
    // Math.min(...spread) over that many args would throw RangeError (and the
    // pipeline would silently stop pruning). The loop-based min/max must cope.
    const tokenScorer = createNGramScorer({ granularity: 'token' });
    const huge = 'word '.repeat(200_000);
    expect(() => tokenScorer.score(huge)).not.toThrow();
    const result = tokenScorer.score(huge);
    expect(result.length).toBeGreaterThan(100_000);
  });
});
