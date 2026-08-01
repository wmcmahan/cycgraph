/**
 * Tests for the rule-based heuristic token scorer and its pruning stage
 * (src/pruning/heuristic.ts).
 */

import { describe, it, expect } from 'vitest';
import { createHeuristicScorer, createHeuristicPruningStage } from '../src/pruning/heuristic.js';
import type { ScoredToken } from '../src/pruning/types.js';
import { DefaultTokenCounter } from '../src/providers/defaults.js';
import { seg, makeContext } from './helpers.js';

const counter = new DefaultTokenCounter();

const scoreOf = (tokens: ScoredToken[], text: string) => tokens.find(t => t.text === text)!.score;

describe('createHeuristicScorer', () => {
  const scorer = createHeuristicScorer();

  it('scores a stop word below a content word', () => {
    const tokens = scorer.score('the important research');

    expect(scoreOf(tokens, 'research')).toBeGreaterThan(scoreOf(tokens, 'the'));
  });

  it('scores a capitalized entity above a plain verb', () => {
    const tokens = scorer.score('Alice works at Acme');

    expect(scoreOf(tokens, 'Alice')).toBeGreaterThan(scoreOf(tokens, 'works'));
  });

  it('scores a number above a stop word', () => {
    const tokens = scorer.score('the score is 92');

    expect(scoreOf(tokens, '92')).toBeGreaterThan(scoreOf(tokens, 'the'));
  });

  it('penalizes a word inside a filler phrase', () => {
    const tokens = scorer.score('in order to improve the system');

    expect(scoreOf(tokens, 'system')).toBeGreaterThan(scoreOf(tokens, 'in'));
  });

  it('scores a structural marker above a stop word', () => {
    const tokens = scorer.score('## the Header');

    expect(scoreOf(tokens, '##')).toBeGreaterThan(scoreOf(tokens, 'the'));
  });

  it('boosts a key-value colon token above a plain word', () => {
    const tokens = scorer.score('config note: value');

    expect(scoreOf(tokens, 'note:')).toBeGreaterThan(scoreOf(tokens, 'value'));
  });

  it('falls back to the segment content itself when the cross-segment corpus is empty', () => {
    const content = 'Alice the Alice unique';

    const emptyCorpus = scorer.score(content, { allContent: [] });
    const noCorpus = scorer.score(content, {});

    expect(emptyCorpus).toEqual(noCorpus);
  });

  it('scores frequency neutrally when the corpus contains only whitespace', () => {
    const tokens = scorer.score('Alice the', { allContent: ['   '] });

    expect(scoreOf(tokens, 'Alice')).toBeGreaterThan(scoreOf(tokens, 'the'));
  });

  it('rewards a word absent from the cross-segment corpus over a frequent one', () => {
    const tokens = scorer.score('zebra mango', { allContent: ['mango mango mango'] });

    expect(scoreOf(tokens, 'zebra')).toBeGreaterThan(scoreOf(tokens, 'mango'));
  });

  it('assigns whitespace a neutral 0.5', () => {
    const space = scorer.score('hello world').find(t => t.text.trim() === '' && t.text.length > 0)!;

    expect(space.score).toBe(0.5);
  });

  it('does not crash on an empty string', () => {
    expect(scorer.score('').length).toBeGreaterThanOrEqual(0);
  });

  it('demotes a custom stop word below a content word', () => {
    const custom = createHeuristicScorer({ customStopWords: ['research'] });

    const tokens = custom.score('important research');

    expect(scoreOf(tokens, 'important')).toBeGreaterThan(scoreOf(tokens, 'research'));
  });

  it('penalizes a word repeated across segments relative to a unique one', () => {
    const tokens = scorer.score('data analysis uniqueword', {
      allContent: ['data is data', 'data shows data', 'data analysis uniqueword'],
    });

    expect(scoreOf(tokens, 'uniqueword')).toBeGreaterThan(scoreOf(tokens, 'data'));
  });

  it('protects negations with a maximal score', () => {
    const notToken = scorer.score('do not delete').find(t => t.text === 'not')!;

    expect(notToken.score).toBe(1.0);
    expect(notToken.protected).toBe(true);
  });

  it('boosts a token whose context window overlaps the query', () => {
    const content = 'the revenue report';

    const withMatch = scoreOf(scorer.score(content, { query: 'revenue' }), 'revenue');
    const withoutMatch = scoreOf(scorer.score(content, { query: 'zzz' }), 'revenue');

    expect(withMatch).toBeGreaterThan(withoutMatch);
  });

  it('treats an all-stop-word query as neutral rather than non-matching', () => {
    const content = 'the revenue report';

    const stopWordQuery = scoreOf(scorer.score(content, { query: 'the' }), 'revenue');
    const nonMatchingQuery = scoreOf(scorer.score(content, { query: 'zzz' }), 'revenue');

    expect(stopWordQuery).toBeGreaterThan(nonMatchingQuery);
  });

  it('adds no query signal when the context window holds only stop words', () => {
    const content = 'the and but or';

    const matching = scorer.score(content, { query: 'revenue' });
    const different = scorer.score(content, { query: 'xyzzy' });

    expect(matching).toEqual(different);
  });

  it('ignores a whitespace-only query', () => {
    const content = 'the revenue report';

    expect(scorer.score(content, { query: '   ' })).toEqual(scorer.score(content));
  });
});

describe('createHeuristicPruningStage', () => {
  const OVER_BUDGET = { maxTokens: 20, outputReserve: 0 };

  it('reduces verbose content below its original size', () => {
    const verbose = 'It should be noted that in order to improve the system we basically need to essentially restructure the very fundamental architecture of the entire application framework in terms of the overall design patterns';

    const result = createHeuristicPruningStage().execute(
      [seg('a', verbose, 'history')],
      makeContext({ ...OVER_BUDGET, tokenCounter: counter }),
    );

    expect(counter.countTokens(result.segments[0].content)).toBeLessThan(counter.countTokens(verbose));
  });

  it('keeps named entities through pruning', () => {
    const content = 'Alice from Acme Corp reported that the very basic and essentially simple findings indicate a score of 92';

    const result = createHeuristicPruningStage().execute(
      [seg('a', content, 'history')],
      makeContext({ maxTokens: 15, tokenCounter: counter }),
    );

    expect(result.segments[0].content).toContain('Alice');
    expect(result.segments[0].content).toContain('92');
  });

  it('names the stage heuristic-pruning', () => {
    expect(createHeuristicPruningStage().name).toBe('heuristic-pruning');
  });

  it('keeps a negation even when the budget forces heavy pruning', () => {
    const content = 'Please do not ever delete the production database under any circumstances whatsoever, as it would be basically catastrophic and essentially unrecoverable for the entire system';

    const result = createHeuristicPruningStage().execute(
      [seg('a', content, 'history')],
      makeContext({ maxTokens: 8, tokenCounter: counter }),
    );
    const pruned = result.segments[0].content;

    expect(counter.countTokens(pruned)).toBeLessThan(counter.countTokens(content));
    expect(pruned).toMatch(/\bnot\b/);
  });
});
