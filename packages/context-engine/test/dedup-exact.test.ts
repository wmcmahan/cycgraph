/**
 * Tests for exact (hash-based) deduplication — `src/memory/dedup/exact.ts`.
 */

import { describe, it, expect } from 'vitest';
import { dedup, createExactDedupStage, isStructuredContent, fnv1a } from '../src/memory/dedup/exact.js';
import { seg, makeContext } from './helpers.js';
import type { PromptSegment } from '../src/pipeline/types.js';

describe('dedup', () => {
  it('removes exact duplicates and keeps the first occurrence', () => {
    const result = dedup(['hello', 'world', 'hello', 'foo']);

    expect(result.unique).toEqual(['hello', 'world', 'foo']);
    expect(result.removed).toBe(1);
  });

  it('keeps the first occurrence of each repeated item', () => {
    const result = dedup(['a', 'b', 'a', 'c', 'b']);

    expect(result.unique).toEqual(['a', 'b', 'c']);
    expect(result.removed).toBe(2);
  });

  it('preserves every empty string without deduping them', () => {
    const result = dedup(['', 'hello', '', 'hello']);

    expect(result.unique).toEqual(['', 'hello', '']);
    expect(result.removed).toBe(1);
  });

  it('returns an empty result for empty input', () => {
    const result = dedup([]);

    expect(result.unique).toEqual([]);
    expect(result.removed).toBe(0);
  });

  it('ignores leading and trailing whitespace when comparing', () => {
    const result = dedup(['  hello  ', 'hello', ' hello']);

    expect(result.unique).toEqual(['  hello  ']);
    expect(result.removed).toBe(2);
  });

  it('removes nothing when all items are unique', () => {
    const result = dedup(['a', 'b', 'c']);

    expect(result.unique).toEqual(['a', 'b', 'c']);
    expect(result.removed).toBe(0);
  });
});

describe('fnv1a', () => {
  it('is deterministic for the same input', () => {
    expect(fnv1a('context-engine')).toBe(fnv1a('context-engine'));
  });

  it('returns an unsigned 32-bit integer', () => {
    const hash = fnv1a('anything at all');

    expect(hash).toBeGreaterThanOrEqual(0);
    expect(hash).toBeLessThanOrEqual(0xffffffff);
    expect(Number.isInteger(hash)).toBe(true);
  });

  it('produces different hashes for different strings', () => {
    expect(fnv1a('alpha')).not.toBe(fnv1a('beta'));
  });

  it('hashes the empty string to the FNV offset basis', () => {
    expect(fnv1a('')).toBe(0x811c9dc5);
  });
});

describe('isStructuredContent', () => {
  it('treats a valid JSON object as structured', () => {
    expect(isStructuredContent('{"a": 1, "b": 2}')).toBe(true);
  });

  it('treats a valid JSON array as structured', () => {
    expect(isStructuredContent('[1, 2, 3]')).toBe(true);
  });

  it('treats text that starts like JSON but does not parse as unstructured', () => {
    expect(isStructuredContent('{ not really json')).toBe(false);
  });

  it('treats multi-line comma-delimited content as CSV', () => {
    expect(isStructuredContent('a,b\n1,2\n3,4')).toBe(true);
  });

  it('treats multi-line tab-delimited content as TSV', () => {
    expect(isStructuredContent('a\tb\n1\t2')).toBe(true);
  });

  it('treats prose without a shared delimiter as unstructured', () => {
    expect(isStructuredContent('This is a paragraph.\nThis is another one.')).toBe(false);
  });

  it('treats the empty string as unstructured', () => {
    expect(isStructuredContent('   ')).toBe(false);
  });

  it('treats a single delimited line as unstructured', () => {
    expect(isStructuredContent('a,b,c')).toBe(false);
  });
});

describe('createExactDedupStage', () => {
  const context = makeContext();

  it('has name exact-dedup', () => {
    expect(createExactDedupStage().name).toBe('exact-dedup');
  });

  it('is declared cross-segment so the incremental pipeline runs it on all segments', () => {
    expect(createExactDedupStage().scope).toBe('cross-segment');
  });

  it('removes duplicate paragraphs within a segment', () => {
    const stage = createExactDedupStage();
    const content = 'paragraph one\n\nparagraph two\n\nparagraph one';

    const result = stage.execute([seg('a', content)], context);

    expect(result.segments[0].content).toBe('paragraph one\n\nparagraph two');
  });

  it('removes a duplicate line that spans two segments', () => {
    const stage = createExactDedupStage();
    const seg1 = seg('a', 'shared line\nunique to a');
    const seg2 = seg('b', 'shared line\nunique to b');

    const result = stage.execute([seg1, seg2], context);

    expect(result.segments[0].content).toContain('shared line');
    expect(result.segments[1].content).not.toContain('shared line');
    expect(result.segments[1].content).toContain('unique to b');
  });

  it('leaves JSON with repeated structural lines intact', () => {
    const stage = createExactDedupStage();
    const json = JSON.stringify(
      { items: [{ type: 'string' }, { type: 'string' }, { type: 'string' }] },
      null,
      2,
    );

    const result = stage.execute([seg('a', json)], context);

    expect(result.segments[0].content).toBe(json);
    expect(JSON.parse(result.segments[0].content).items).toHaveLength(3);
  });

  it('does not drop duplicate CSV rows', () => {
    const stage = createExactDedupStage();
    const csv = 'a,b\n1,2\n1,2\n3,4';

    const result = stage.execute([seg('a', csv)], context);

    expect(result.segments[0].content.split('\n')).toHaveLength(4);
  });

  it('preserves empty content', () => {
    const stage = createExactDedupStage();

    const result = stage.execute([seg('a', '')], context);

    expect(result.segments[0].content).toBe('');
  });

  it('passes single-line content through unchanged', () => {
    const stage = createExactDedupStage();

    const result = stage.execute([seg('a', 'just one line')], context);

    expect(result.segments[0].content).toBe('just one line');
  });

  it('preserves segment metadata on the deduped output', () => {
    const stage = createExactDedupStage();
    const input: PromptSegment = seg('a', 'hello\nhello', 'memory', {
      priority: 5,
      metadata: { key: 'value' },
    });

    const result = stage.execute([input], context);

    expect(result.segments[0].role).toBe('memory');
    expect(result.segments[0].priority).toBe(5);
    expect(result.segments[0].metadata).toEqual({ key: 'value' });
  });
});
