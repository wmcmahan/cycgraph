import { describe, it, expect } from 'vitest';
import { createHeuristicScorer, createHeuristicPruningStage } from '../src/pruning/heuristic.js';
import type { PromptSegment, BudgetConfig } from '../src/pipeline/types.js';
import { DefaultTokenCounter } from '../src/providers/defaults.js';

const counter = new DefaultTokenCounter();

function makeSegment(id: string, content: string): PromptSegment {
  return { id, content, role: 'memory', priority: 1, locked: false };
}

describe('createHeuristicScorer', () => {
  const scorer = createHeuristicScorer();

  it('scores stop words lower than content words', () => {
    const tokens = scorer.score('the important research');
    const theScore = tokens.find(t => t.text === 'the')!.score;
    const researchScore = tokens.find(t => t.text === 'research')!.score;
    expect(researchScore).toBeGreaterThan(theScore);
  });

  it('scores capitalized words (entities) high', () => {
    const tokens = scorer.score('Alice works at Acme');
    const aliceScore = tokens.find(t => t.text === 'Alice')!.score;
    const worksScore = tokens.find(t => t.text === 'works')!.score;
    expect(aliceScore).toBeGreaterThan(worksScore);
  });

  it('scores numbers high', () => {
    const tokens = scorer.score('the score is 92');
    const numScore = tokens.find(t => t.text === '92')!.score;
    const theScore = tokens.find(t => t.text === 'the')!.score;
    expect(numScore).toBeGreaterThan(theScore);
  });

  it('penalizes filler phrases', () => {
    const tokens = scorer.score('in order to improve the system');
    const inScore = tokens.find(t => t.text === 'in')!.score;
    const systemScore = tokens.find(t => t.text === 'system')!.score;
    // 'in' inside "in order to" should be penalized
    expect(systemScore).toBeGreaterThan(inScore);
  });

  it('boosts structural markers relative to stop words', () => {
    const tokens = scorer.score('## the Header');
    const headerMarker = tokens.find(t => t.text === '##')!.score;
    const theScore = tokens.find(t => t.text === 'the')!.score;
    expect(headerMarker).toBeGreaterThan(theScore);
  });

  it('assigns neutral scores to whitespace', () => {
    const tokens = scorer.score('hello world');
    const space = tokens.find(t => t.text.trim() === '' && t.text.length > 0);
    expect(space?.score).toBe(0.5);
  });

  it('handles empty string without crashing', () => {
    const tokens = scorer.score('');
    // Returns one token for the empty string — scorer doesn't crash
    expect(tokens.length).toBeGreaterThanOrEqual(0);
  });

  it('accepts custom stop words', () => {
    const custom = createHeuristicScorer({ customStopWords: ['research'] });
    const tokens = custom.score('important research');
    const researchScore = tokens.find(t => t.text === 'research')!.score;
    const importantScore = tokens.find(t => t.text === 'important')!.score;
    expect(importantScore).toBeGreaterThan(researchScore);
  });

  it('uses cross-segment frequency when allContent provided', () => {
    const tokens = scorer.score('data analysis uniqueword', {
      allContent: ['data is data', 'data shows data', 'data analysis uniqueword'],
    });
    // 'data' appears in all 3 segments — should be penalized relative to 'uniqueword' appearing in 1
    const dataScore = tokens.find(t => t.text === 'data')!.score;
    const uniqueScore = tokens.find(t => t.text === 'uniqueword')!.score;
    expect(uniqueScore).toBeGreaterThan(dataScore);
  });
});

describe('createHeuristicPruningStage', () => {
  it('reduces verbose content', () => {
    const stage = createHeuristicPruningStage();
    const verbose = 'It should be noted that in order to improve the system we basically need to essentially restructure the very fundamental architecture of the entire application framework in terms of the overall design patterns';
    const segments = [makeSegment('a', verbose)];
    const context = {
      tokenCounter: counter,
      budget: { maxTokens: 20, outputReserve: 0 } as BudgetConfig,
    };

    const result = stage.execute(segments, context);
    const inputTokens = counter.countTokens(verbose);
    const outputTokens = counter.countTokens(result.segments[0].content);
    expect(outputTokens).toBeLessThan(inputTokens);
  });

  it('preserves named entities through pruning', () => {
    const stage = createHeuristicPruningStage();
    const content = 'Alice from Acme Corp reported that the very basic and essentially simple findings indicate a score of 92';
    const segments = [makeSegment('a', content)];
    const context = {
      tokenCounter: counter,
      budget: { maxTokens: 15, outputReserve: 0 } as BudgetConfig,
    };

    const result = stage.execute(segments, context);
    expect(result.segments[0].content).toContain('Alice');
    expect(result.segments[0].content).toContain('92');
  });

  it('has name heuristic-pruning', () => {
    const stage = createHeuristicPruningStage();
    expect(stage.name).toBe('heuristic-pruning');
  });

  it('never prunes negations (meaning must not invert under budget pressure)', () => {
    const stage = createHeuristicPruningStage();
    // A safety-critical instruction padded with low-value filler so the pruner
    // is forced to cut. The negation "not" must survive.
    const content = 'Please do not ever delete the production database under any circumstances whatsoever, as it would be basically catastrophic and essentially unrecoverable for the entire system';
    const segments = [makeSegment('a', content)];
    const context = {
      tokenCounter: counter,
      budget: { maxTokens: 8, outputReserve: 0 } as BudgetConfig,
    };

    const result = stage.execute(segments, context);
    const pruned = result.segments[0].content;
    // Pruning happened...
    expect(counter.countTokens(pruned)).toBeLessThan(counter.countTokens(content));
    // ...but the negation survived so "delete" is never left unqualified.
    expect(pruned).toMatch(/\bnot\b/);
  });
});
