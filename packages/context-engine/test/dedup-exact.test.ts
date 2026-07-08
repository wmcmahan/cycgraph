import { describe, it, expect } from 'vitest';
import { dedup, createExactDedupStage } from '../src/memory/dedup/exact.js';
import type { PromptSegment, BudgetConfig } from '../src/pipeline/types.js';
import { DefaultTokenCounter } from '../src/providers/defaults.js';

describe('dedup', () => {
  it('removes exact duplicates', () => {
    const result = dedup(['hello', 'world', 'hello', 'foo']);
    expect(result.unique).toEqual(['hello', 'world', 'foo']);
    expect(result.removed).toBe(1);
  });

  it('keeps first occurrence', () => {
    const result = dedup(['a', 'b', 'a', 'c', 'b']);
    expect(result.unique).toEqual(['a', 'b', 'c']);
    expect(result.removed).toBe(2);
  });

  it('preserves empty strings', () => {
    const result = dedup(['', 'hello', '', 'hello']);
    expect(result.unique).toEqual(['', 'hello', '']);
    expect(result.removed).toBe(1);
  });

  it('handles empty input', () => {
    const result = dedup([]);
    expect(result.unique).toEqual([]);
    expect(result.removed).toBe(0);
  });

  it('ignores leading/trailing whitespace for comparison', () => {
    const result = dedup(['  hello  ', 'hello', ' hello']);
    expect(result.unique).toEqual(['  hello  ']);
    expect(result.removed).toBe(2);
  });

  it('handles all unique items', () => {
    const result = dedup(['a', 'b', 'c']);
    expect(result.unique).toEqual(['a', 'b', 'c']);
    expect(result.removed).toBe(0);
  });
});

describe('createExactDedupStage', () => {
  const counter = new DefaultTokenCounter();
  const context = {
    tokenCounter: counter,
    budget: { maxTokens: 4096, outputReserve: 0 } as BudgetConfig,
  };

  function makeSegment(id: string, content: string): PromptSegment {
    return { id, content, role: 'memory', priority: 1, locked: false };
  }

  it('removes duplicate paragraphs within a segment', () => {
    const stage = createExactDedupStage();
    const content = 'paragraph one\n\nparagraph two\n\nparagraph one';
    const result = stage.execute([makeSegment('a', content)], context);
    expect(result.segments[0].content).toBe('paragraph one\n\nparagraph two');
  });

  it('removes duplicates across segments', () => {
    const stage = createExactDedupStage();
    const seg1 = makeSegment('a', 'shared line\nunique to a');
    const seg2 = makeSegment('b', 'shared line\nunique to b');

    const result = stage.execute([seg1, seg2], context);
    expect(result.segments[0].content).toContain('shared line');
    expect(result.segments[1].content).not.toContain('shared line');
    expect(result.segments[1].content).toContain('unique to b');
  });

  it('is declared cross-segment (so the incremental pipeline runs it on all segments)', () => {
    expect(createExactDedupStage().scope).toBe('cross-segment');
  });

  it('does not corrupt JSON with repeated structural lines', () => {
    const stage = createExactDedupStage();
    // Pretty-printed JSON with repeated `},` and identical value lines. Naive
    // per-line dedup would drop the repeats and produce invalid JSON.
    const json = JSON.stringify(
      { items: [{ type: 'string' }, { type: 'string' }, { type: 'string' }] },
      null,
      2,
    );
    const result = stage.execute([makeSegment('a', json)], context);
    // Round-trips: structure preserved, nothing dropped.
    expect(result.segments[0].content).toBe(json);
    expect(() => JSON.parse(result.segments[0].content)).not.toThrow();
    expect(JSON.parse(result.segments[0].content).items).toHaveLength(3);
  });

  it('does not drop duplicate CSV rows', () => {
    const stage = createExactDedupStage();
    const csv = 'a,b\n1,2\n1,2\n3,4';
    const result = stage.execute([makeSegment('a', csv)], context);
    // All 4 rows preserved (the two identical `1,2` rows are real data).
    expect(result.segments[0].content.split('\n')).toHaveLength(4);
  });

  it('preserves empty content', () => {
    const stage = createExactDedupStage();
    const result = stage.execute([makeSegment('a', '')], context);
    expect(result.segments[0].content).toBe('');
  });

  it('handles single-line content', () => {
    const stage = createExactDedupStage();
    const result = stage.execute([makeSegment('a', 'just one line')], context);
    expect(result.segments[0].content).toBe('just one line');
  });

  it('preserves segment metadata', () => {
    const stage = createExactDedupStage();
    const seg: PromptSegment = {
      id: 'a',
      content: 'hello\nhello',
      role: 'memory',
      priority: 5,
      locked: false,
      metadata: { key: 'value' },
    };
    const result = stage.execute([seg], context);
    expect(result.segments[0].role).toBe('memory');
    expect(result.segments[0].priority).toBe(5);
    expect(result.segments[0].metadata).toEqual({ key: 'value' });
  });
});
