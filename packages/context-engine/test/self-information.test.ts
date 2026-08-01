/**
 * Tests for the self-information scorer, stage, and precomputation
 * (src/pruning/self-information.ts).
 */

import { describe, it, expect } from 'vitest';
import {
  precomputeImportanceScores,
  createSelfInformationScorer,
  createSelfInformationStage,
} from '../src/pruning/self-information.js';
import type { CompressionProvider } from '../src/providers/types.js';
import { DefaultTokenCounter } from '../src/providers/defaults.js';
import { seg, makeContext } from './helpers.js';

const counter = new DefaultTokenCounter();

class MockCompressionProvider implements CompressionProvider {
  callCount = 0;

  async scoreTokenImportance(tokens: string[], context?: string): Promise<number[]> {
    this.callCount++;
    return tokens.map(t => {
      const trimmed = t.trim();
      if (trimmed.length === 0) return 0.5;
      let score = Math.min(1.0, trimmed.length / 20);
      if (context && trimmed.toLowerCase().includes(context.toLowerCase().slice(0, 5))) {
        score = Math.min(1.0, score + 0.3);
      }
      return score;
    });
  }
}

describe('precomputeImportanceScores', () => {
  it('scores every distinct segment', async () => {
    const segments = [
      seg('a', 'Short sentence. A much longer and more detailed explanation.'),
      seg('b', 'Another piece of content here.'),
    ];

    const scores = await precomputeImportanceScores(segments, new MockCompressionProvider(), {
      granularity: 'sentence',
    });

    expect(scores.size).toBe(2);
    expect(scores.has(segments[0].content)).toBe(true);
    expect(scores.has(segments[1].content)).toBe(true);
  });

  it('scores identical segments only once', async () => {
    const provider = new MockCompressionProvider();
    const segments = [seg('a', 'Same content repeated.'), seg('b', 'Same content repeated.')];

    const scores = await precomputeImportanceScores(segments, provider);

    expect(scores.size).toBe(1);
    expect(provider.callCount).toBe(1);
  });

  it('splits into whitespace units at token granularity', async () => {
    const segments = [seg('a', 'hello world foo')];

    const scores = await precomputeImportanceScores(segments, new MockCompressionProvider(), {
      granularity: 'token',
    });

    expect(scores.get(segments[0].content)!.length).toBeGreaterThanOrEqual(3);
  });

  it('splits into one unit per sentence at sentence granularity', async () => {
    const segments = [seg('a', 'First sentence. Second sentence. Third sentence.')];

    const scores = await precomputeImportanceScores(segments, new MockCompressionProvider(), {
      granularity: 'sentence',
    });

    expect(scores.get(segments[0].content)!).toHaveLength(3);
  });

  it('splits on comma/semicolon boundaries at phrase granularity', async () => {
    const content = 'hello world, foo bar; baz';
    const segments = [seg('a', content)];

    const scores = await precomputeImportanceScores(segments, new MockCompressionProvider(), {
      granularity: 'phrase',
    });

    expect(scores.get(content)!).toHaveLength(5);
  });

  it('drops the empty trailing unit left by whitespace after a final sentence', async () => {
    const content = 'First idea. Second idea. ';
    const segments = [seg('a', content)];

    const scores = await precomputeImportanceScores(segments, new MockCompressionProvider(), {
      granularity: 'sentence',
    });

    expect(scores.get(content)!).toHaveLength(2);
  });

  it('assigns a neutral 0.5 to units the provider leaves unscored', async () => {
    const emptyProvider: CompressionProvider = {
      scoreTokenImportance: async () => [],
    };
    const content = 'alpha beta gamma';
    const segments = [seg('a', content)];

    const scores = await precomputeImportanceScores(segments, emptyProvider, { granularity: 'token' });

    expect(scores.get(content)!.every(u => u.score === 0.5)).toBe(true);
  });

  it('boosts a query-matching unit above a non-matching one', async () => {
    const segments = [seg('a', 'cost reduction strategy. xyz.')];

    const scores = await precomputeImportanceScores(segments, new MockCompressionProvider(), {
      granularity: 'sentence',
      query: 'cost',
    });

    const tokens = scores.get(segments[0].content)!;
    expect(tokens[0].score).toBeGreaterThan(tokens[1].score);
  });
});

describe('createSelfInformationScorer', () => {
  it('returns pre-computed scores verbatim when the content is known', async () => {
    const content = 'Test content here.';
    const precomputed = await precomputeImportanceScores([seg('a', content)], new MockCompressionProvider());

    const scored = createSelfInformationScorer({ precomputed }).score(content);

    expect(scored).toEqual(precomputed.get(content));
  });

  it('falls back to the n-gram scorer for unknown content', () => {
    const scorer = createSelfInformationScorer({ precomputed: new Map(), granularity: 'token' });

    const nonWs = scorer.score('the the the the xylophone the the the').filter(t => t.text.trim().length > 0);

    const allSame = nonWs.every(t => t.score === nonWs[0].score);
    expect(allSame).toBe(false);
  });

  it('gives a rare fallback token a different score than a common one', () => {
    const scorer = createSelfInformationScorer({ precomputed: new Map(), granularity: 'token' });

    const nonWs = scorer.score('common common common rare_xyzzy common common').filter(t => t.text.trim().length > 0);

    const rare = nonWs.find(t => t.text === 'rare_xyzzy')!;
    const common = nonWs.find(t => t.text === 'common')!;
    expect(rare.score).not.toBe(common.score);
  });

  it('uses a custom fallback scorer when one is provided', () => {
    const customScorer = {
      score: (content: string) => [{ text: content, score: 0.99, offset: 0 }],
    };
    const scorer = createSelfInformationScorer({ precomputed: new Map(), fallbackScorer: customScorer });

    const scored = scorer.score('anything');

    expect(scored).toEqual([{ text: 'anything', score: 0.99, offset: 0 }]);
  });

  it('returns the whole input as one unit when there is no sentence punctuation', () => {
    const scorer = createSelfInformationScorer({ precomputed: new Map(), granularity: 'sentence' });

    const scored = scorer.score('A fragment without any period');

    expect(scored).toHaveLength(1);
    expect(scored[0].text).toBe('A fragment without any period');
  });

  it('returns an empty array for empty content', () => {
    expect(createSelfInformationScorer({ precomputed: new Map() }).score('')).toHaveLength(0);
  });
});

describe('createSelfInformationStage', () => {
  it('reduces content to fit the budget when scores are pre-computed', async () => {
    const content = 'A. Very important detailed technical explanation of the system architecture and design. B.';
    const segments = [seg('a', content)];
    const precomputed = await precomputeImportanceScores(segments, new MockCompressionProvider(), {
      granularity: 'sentence',
    });

    const result = createSelfInformationStage({ precomputed }).execute(
      segments,
      makeContext({ maxTokens: 10, tokenCounter: counter }),
    );

    expect(counter.countTokens(result.segments[0].content)).toBeLessThanOrEqual(counter.countTokens(content));
  });

  it('passes content through when no pre-computed scores exist and it is within budget', () => {
    const content = 'short';
    const segments = [seg('a', content)];

    const result = createSelfInformationStage({}).execute(
      segments,
      makeContext({ maxTokens: 1000, tokenCounter: counter }),
    );

    expect(result.segments[0].content).toBe(content);
  });

  it('names the stage self-information-pruning', () => {
    expect(createSelfInformationStage({}).name).toBe('self-information-pruning');
  });
});
