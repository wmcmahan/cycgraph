/**
 * Tests for chain-of-thought distillation (src/pruning/cot-distillation.ts).
 */

import { describe, it, expect } from 'vitest';
import { distillCoT, createCotDistillationStage, DEFAULT_DELIMITERS } from '../src/pruning/cot-distillation.js';
import { DefaultTokenCounter } from '../src/providers/defaults.js';
import { seg, makeContext } from './helpers.js';

const counter = new DefaultTokenCounter();

describe('distillCoT', () => {
  it('removes a <think> block and keeps its marked conclusion', () => {
    const content = 'Start. <think>Long reasoning about the problem. Let me consider options. Therefore: The answer is 42.</think> End.';

    const result = distillCoT(content);

    expect(result.tracesRemoved).toBe(1);
    expect(result.distilled).toContain('[Reasoning distilled] The answer is 42.');
    expect(result.distilled).not.toContain('Long reasoning');
    expect(result.distilled).toContain('Start.');
    expect(result.distilled).toContain('End.');
  });

  it('removes a <reasoning> block', () => {
    const result = distillCoT('Before <reasoning>Step 1. Step 2. In conclusion: Use method B.</reasoning> After');

    expect(result.tracesRemoved).toBe(1);
    expect(result.distilled).toContain('Use method B');
    expect(result.distilled).not.toContain('Step 1');
  });

  it('removes a <scratchpad> block', () => {
    const result = distillCoT('Result: <scratchpad>Working through calculations...</scratchpad> Done.');

    expect(result.tracesRemoved).toBe(1);
    expect(result.distilled).toContain('Done.');
  });

  it('removes an <antThinking> block', () => {
    const result = distillCoT('<antThinking>Internal deliberation. The answer is: Paris.</antThinking>The capital is Paris.');

    expect(result.tracesRemoved).toBe(1);
    expect(result.distilled).toContain('Paris');
  });

  it('removes a <thought> block', () => {
    const result = distillCoT('<thought>Let me think about this carefully. Thus: Option A is best.</thought>I recommend Option A.');

    expect(result.tracesRemoved).toBe(1);
    expect(result.distilled).toContain('Option A');
  });

  it('removes multiple blocks in one string and keeps the text between them', () => {
    const result = distillCoT('<think>Reasoning 1. Therefore: A.</think> Middle. <think>Reasoning 2. Therefore: B.</think> End.');

    expect(result.tracesRemoved).toBe(2);
    expect(result.distilled).toContain('A.');
    expect(result.distilled).toContain('B.');
    expect(result.distilled).toContain('Middle.');
  });

  it('leaves an unclosed delimiter untouched', () => {
    const content = 'Before <think>unclosed reasoning without end tag. After.';

    const result = distillCoT(content);

    expect(result.tracesRemoved).toBe(0);
    expect(result.distilled).toBe(content);
  });

  it('emits a bare removal marker when no conclusion can be extracted', () => {
    const result = distillCoT('<think>A</think>');

    expect(result.distilled).toContain('[Reasoning trace removed]');
  });

  it('falls back to the last paragraph as the conclusion', () => {
    const result = distillCoT('<think>First paragraph of reasoning.\n\nSecond paragraph of reasoning.\n\nFinal conclusion paragraph.</think>');

    expect(result.distilled).toContain('Final conclusion paragraph');
    expect(result.distilled).not.toContain('First paragraph');
  });

  it('falls back to the last sentence of a single unmarked paragraph', () => {
    const result = distillCoT('<think>First idea here. Second idea follows.</think>');

    expect(result.distilled).toContain('[Reasoning distilled] Second idea follows.');
    expect(result.distilled).not.toContain('First idea');
  });

  it('skips a conclusion marker with no trailing text and uses the last sentence', () => {
    const result = distillCoT('<think>reasoning goes here. Therefore:</think>');

    expect(result.tracesRemoved).toBe(1);
    expect(result.distilled).toContain('[Reasoning distilled] Therefore:');
  });

  it('processes anthropic and generic delimiters for a claude model', () => {
    const result = distillCoT('<antThinking>Deliberation. The answer is: Z.</antThinking> <think>deepseek only</think>', {}, 'claude-3-5');

    expect(result.tracesRemoved).toBe(1);
    expect(result.distilled).toContain('<think>deepseek only</think>');
  });

  it('maps o1, o3, and o4 models to the openai family', () => {
    for (const model of ['o1-preview', 'o3-mini', 'o4-turbo']) {
      const result = distillCoT('<thought>Reasoning. Thus: Q.</thought> <think>deepseek only</think>', {}, model);

      expect(result.tracesRemoved).toBe(1);
      expect(result.distilled).toContain('<think>deepseek only</think>');
    }
  });

  it('processes only same-family and generic delimiters for a known model', () => {
    const result = distillCoT('<think>DeepSeek reasoning. Therefore: X.</think> <antThinking>Anthropic thinking.</antThinking>', {}, 'deepseek-v3');

    expect(result.tracesRemoved).toBe(1);
    expect(result.distilled).toContain('<antThinking>');
  });

  it('processes generic delimiters regardless of model', () => {
    const result = distillCoT('<reasoning>Generic trace. In conclusion: Done.</reasoning>', {}, 'deepseek-v3');

    expect(result.tracesRemoved).toBe(1);
  });

  it('processes all delimiters when the model family is unknown', () => {
    const result = distillCoT('<think>A. Therefore: X.</think> <antThinking>B. Therefore: Y.</antThinking>', {}, 'some-unknown-model');

    expect(result.tracesRemoved).toBe(2);
  });

  it('replaces the block with a bare marker when preserveConclusion is false', () => {
    const result = distillCoT('<think>Long reasoning. Therefore: The answer.</think>', { preserveConclusion: false });

    expect(result.distilled).toBe('[Reasoning trace removed]');
  });

  it('reports the number of tokens evicted', () => {
    const content = `<think>${'x '.repeat(200)}Therefore: Answer.</think>`;

    expect(distillCoT(content).tokensEvicted).toBeGreaterThan(50);
  });

  it('evicts more tokens with a smaller charsPerToken ratio', () => {
    const content = `<think>${'x '.repeat(200)}Therefore: Answer.</think>`;

    const defaultResult = distillCoT(content);
    const customResult = distillCoT(content, { charsPerToken: 2 });

    expect(customResult.tokensEvicted).toBeGreaterThan(defaultResult.tokensEvicted);
  });

  it('defaults charsPerToken to 4 when the option is omitted', () => {
    const content = `<think>${'x '.repeat(200)}Therefore: Answer.</think>`;

    expect(distillCoT(content).tokensEvicted).toBe(distillCoT(content, { charsPerToken: 4 }).tokensEvicted);
  });

  it('processes the outermost delimiter pair for nested blocks', () => {
    const result = distillCoT('<think>Outer reasoning <think>inner nested</think> still outer. Therefore: Result.</think>');

    expect(result.tracesRemoved).toBeGreaterThanOrEqual(1);
    expect(result.distilled).not.toContain('Outer reasoning');
  });

  it('returns the content unchanged when there is no reasoning block', () => {
    const content = 'Just a regular response with no reasoning blocks.';

    const result = distillCoT(content);

    expect(result.tracesRemoved).toBe(0);
    expect(result.distilled).toBe(content);
  });
});

describe('createCotDistillationStage', () => {
  it('distills reasoning in a pipeline segment', () => {
    const content = 'Answer: <think>Long thinking process. Lots of reasoning here. Therefore: 42.</think> The result is 42.';

    const result = createCotDistillationStage().execute([seg('a', content)], makeContext({ tokenCounter: counter }));

    expect(result.segments[0].content).not.toContain('Long thinking process');
    expect(result.segments[0].content).toContain('42');
  });

  it('passes a segment through when it has no reasoning block', () => {
    const content = 'No reasoning here.';

    const result = createCotDistillationStage().execute([seg('a', content)], makeContext({ tokenCounter: counter }));

    expect(result.segments[0].content).toBe(content);
  });

  it('names the stage cot-distillation', () => {
    expect(createCotDistillationStage().name).toBe('cot-distillation');
  });
});

describe('DEFAULT_DELIMITERS', () => {
  it('covers the deepseek, anthropic, openai, and generic families', () => {
    const families = new Set(DEFAULT_DELIMITERS.map(d => d.family));

    expect(families.has('deepseek')).toBe(true);
    expect(families.has('anthropic')).toBe(true);
    expect(families.has('openai')).toBe(true);
    expect(families.has('generic')).toBe(true);
  });
});
