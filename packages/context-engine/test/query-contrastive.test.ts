/**
 * Tests for the query-contrastive behavior of the heuristic scorer
 * (pruning/heuristic): query terms boost nearby tokens.
 */

import { describe, it, expect } from 'vitest';
import { createHeuristicScorer } from '../src/pruning/heuristic.js';

describe('createHeuristicScorer query weighting', () => {
  it('scores a query term higher than a distant token', () => {
    const scorer = createHeuristicScorer({ queryWeight: 0.4 });
    const content = 'alpha beta gamma delta epsilon zeta kubernetes eta theta iota';

    const result = scorer.score(content, { query: 'kubernetes' });

    const kube = result.find(t => t.text === 'kubernetes')!;
    const alpha = result.find(t => t.text === 'alpha')!;
    expect(kube.score).toBeGreaterThan(alpha.score);
  });

  it('boosts tokens near query terms above tokens outside the query window', () => {
    const scorer = createHeuristicScorer({ queryWeight: 0.4 });
    const content = 'aaa bbb ccc ddd eee fff ggg hhh iii jjj kkk lll mmm nnn kubernetes target';

    const result = scorer.score(content, { query: 'kubernetes target' });

    const kube = result.find(t => t.text === 'kubernetes')!;
    const aaa = result.find(t => t.text === 'aaa')!;
    expect(kube.score).toBeGreaterThan(aaa.score);
  });

  it('scores an in-window query term higher than a far one via Jaccard overlap', () => {
    const scorer = createHeuristicScorer({ queryWeight: 0.5 });
    const content = 'machine learning algorithms optimize neural network performance evaluation';

    const result = scorer.score(content, { query: 'machine learning' });

    const machine = result.find(t => t.text === 'machine')!;
    const evaluation = result.find(t => t.text === 'evaluation')!;
    expect(machine.score).toBeGreaterThan(evaluation.score);
  });

  it('scores identically with and without an explicitly undefined query', () => {
    const scorer = createHeuristicScorer();
    const content = 'the important research data';

    const withoutQuery = scorer.score(content);
    const withUndefinedQuery = scorer.score(content, { query: undefined });

    expect(withUndefinedQuery.length).toBe(withoutQuery.length);
    for (let i = 0; i < withoutQuery.length; i++) {
      expect(withUndefinedQuery[i].score).toBeCloseTo(withoutQuery[i].score, 10);
    }
  });

  it('scores identically for an empty query and no query', () => {
    const scorer = createHeuristicScorer({ queryWeight: 0.2 });
    const content = 'hello world test';

    const withEmpty = scorer.score(content, { query: '' });
    const withoutQuery = scorer.score(content);

    for (let i = 0; i < withoutQuery.length; i++) {
      expect(withEmpty[i].score).toBeCloseTo(withoutQuery[i].score, 10);
    }
  });

  it('scores identically for a whitespace-only query and no query', () => {
    const scorer = createHeuristicScorer({ queryWeight: 0.2 });
    const content = 'hello world test';

    const withWhitespace = scorer.score(content, { query: '   ' });
    const withoutQuery = scorer.score(content);

    for (let i = 0; i < withoutQuery.length; i++) {
      expect(withWhitespace[i].score).toBeCloseTo(withoutQuery[i].score, 10);
    }
  });

  it('barely shifts scores for a stopword-only query', () => {
    const scorer = createHeuristicScorer({ queryWeight: 0.2 });
    const content = 'important research findings data';

    const withStopwords = scorer.score(content, { query: 'the and or but' });
    const withoutQuery = scorer.score(content);

    for (let i = 0; i < withoutQuery.length; i++) {
      expect(Math.abs(withStopwords[i].score - withoutQuery[i].score)).toBeLessThan(0.15);
    }
  });

  it('leaves scores unchanged when queryWeight is 0', () => {
    const scorer = createHeuristicScorer({ queryWeight: 0 });
    const content = 'important research data analysis';

    const withQuery = scorer.score(content, { query: 'research' });
    const withoutQuery = scorer.score(content);

    for (let i = 0; i < withoutQuery.length; i++) {
      expect(withQuery[i].score).toBeCloseTo(withoutQuery[i].score, 10);
    }
  });

  it('still ranks a query term above a distant token when queryWeight is 1', () => {
    const scorer = createHeuristicScorer({ queryWeight: 1 });
    const content = 'alpha one two three four five six seven eight nine ten eleven twelve kubernetes nearby';

    const result = scorer.score(content, { query: 'kubernetes' });

    const nonWhitespace = result.filter(t => t.text.trim().length > 0);
    const kube = nonWhitespace.find(t => t.text === 'kubernetes')!;
    const alpha = nonWhitespace.find(t => t.text === 'alpha')!;
    expect(kube.score).toBeGreaterThan(alpha.score);
  });

  it('boosts entities above verbs when no query is given', () => {
    const scorer = createHeuristicScorer({ queryWeight: 0.2 });
    const content = 'Alice works at Acme Corp';

    const result = scorer.score(content);

    const alice = result.find(t => t.text === 'Alice')!;
    const works = result.find(t => t.text === 'works')!;
    expect(alice.score).toBeGreaterThan(works.score);
  });

  it('scores content words above stopwords with the default query weight', () => {
    const scorer = createHeuristicScorer();

    const tokens = scorer.score('the important research');

    const the = tokens.find(t => t.text === 'the')!;
    const research = tokens.find(t => t.text === 'research')!;
    expect(research.score).toBeGreaterThan(the.score);
  });
});
