/**
 * MuSiQue loader + alias-aware scoring tests.
 *
 * The loader is exercised against a small fixture written to a temp file
 * (never the real 30MB download), covering the jsonl parse, the
 * paragraph -> document mapping, alias threading, the answerable guard,
 * and subset determinism. Scoring tests pin the max-over-golds protocol.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { selectMusiqueSubset } from '../../src/bench/dataset/musique.js';
import { bestExactMatch, bestF1, f1Score } from '../../src/bench/metrics.js';

const dir = mkdtempSync(join(tmpdir(), 'musique-test-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function makeItem(id: string, overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    id,
    question: `Question for ${id}?`,
    answer: `answer-${id}`,
    answer_aliases: [],
    answerable: true,
    paragraphs: Array.from({ length: 20 }, (_, i) => ({
      idx: i,
      title: `${id}-title-${i}`,
      paragraph_text: `Paragraph ${i} text for ${id}.`,
      is_supporting: i < 2,
    })),
    ...overrides,
  };
}

function writeFixture(name: string, items: Record<string, unknown>[]): string {
  const path = join(dir, name);
  writeFileSync(path, items.map(i => JSON.stringify(i)).join('\n') + '\n');
  return path;
}

describe('selectMusiqueSubset', () => {
  it('maps jsonl records to BenchQuestions with all 20 paragraphs', () => {
    const path = writeFixture('basic.jsonl', [
      makeItem('2hop__1_2', { answer_aliases: ['alias one', '  '] }),
      makeItem('4hop1__3_4_5_6'),
    ]);

    const { questions } = selectMusiqueSubset(path, 2, 1);

    expect(questions).toHaveLength(2);
    const byId = new Map(questions.map(q => [q.id, q]));
    const twoHop = byId.get('2hop__1_2')!;
    expect(twoHop.question).toBe('Question for 2hop__1_2?');
    expect(twoHop.answer).toBe('answer-2hop__1_2');
    // Blank aliases are dropped, real ones kept
    expect(twoHop.answerAliases).toEqual(['alias one']);
    expect(twoHop.documents).toHaveLength(20);
    expect(twoHop.documents[0]).toEqual({
      title: '2hop__1_2-title-0',
      text: 'Paragraph 0 text for 2hop__1_2.',
    });
  });

  it('filters unanswerable items (guards against the -Full variant)', () => {
    const path = writeFixture('answerable.jsonl', [
      makeItem('2hop__1_2'),
      makeItem('2hop__3_4', { answerable: false }),
    ]);

    const { questions } = selectMusiqueSubset(path, 10, 1);
    expect(questions.map(q => q.id)).toEqual(['2hop__1_2']);
  });

  it('subset selection is deterministic for a seed and differs across seeds', () => {
    const items = Array.from({ length: 30 }, (_, i) => makeItem(`2hop__${i}_x`));
    const path = writeFixture('seeds.jsonl', items);

    const a = selectMusiqueSubset(path, 10, 42);
    const b = selectMusiqueSubset(path, 10, 42);
    const c = selectMusiqueSubset(path, 10, 43);

    expect(a.questions.map(q => q.id)).toEqual(b.questions.map(q => q.id));
    expect(a.subsetHash).toBe(b.subsetHash);
    expect(a.questions.map(q => q.id)).not.toEqual(c.questions.map(q => q.id));
    // Seeded shuffle of the full set, not "first N"
    expect(a.questions.map(q => q.id)).not.toEqual(items.slice(0, 10).map(i => i.id));
  });
});

describe('max-over-golds scoring', () => {
  it('bestExactMatch scores full credit when the prediction matches any alias', () => {
    expect(bestExactMatch('NYC', ['New York City', 'NYC'])).toBe(1);
    expect(bestExactMatch('Boston', ['New York City', 'NYC'])).toBe(0);
  });

  it('bestF1 takes the max across golds', () => {
    const golds = ['Miquette Giraudy', 'Giraudy'];
    expect(bestF1('Giraudy', golds)).toBe(1);
    // Against only the full name it would be partial credit
    expect(f1Score('Giraudy', golds[0])).toBeLessThan(1);
  });

  it('single-gold behavior is unchanged (HotpotQA path)', () => {
    expect(bestF1('Denver', ['Denver'])).toBe(f1Score('Denver', 'Denver'));
    expect(bestExactMatch('', ['Denver'])).toBe(0);
  });
});
