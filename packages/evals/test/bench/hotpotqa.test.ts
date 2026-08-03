/**
 * HotpotQA loader tests.
 *
 * `selectSubset` is exercised against a small fixture on a temp file (never
 * the real 45MB download); the subset artifact it writes lands in the
 * gitignored bench-data cache, same as the MuSiQue loader test. The
 * network `fetchHotpotQA` download is covered in dataset-download.test.ts.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { selectSubset, SMOKE_QUESTIONS } from '../../src/bench/dataset/hotpotqa.js';

const dir = mkdtempSync(join(tmpdir(), 'hotpot-test-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function makeItem(id: string): Record<string, unknown> {
  return {
    _id: id,
    question: `Question for ${id}?`,
    answer: `answer-${id}`,
    context: [
      [`${id}-gold`, [`First sentence for ${id}.`, `Second sentence for ${id}.`]],
      [`${id}-distractor`, [`Unrelated sentence.`]],
    ],
  };
}

function writeFixture(name: string, items: Record<string, unknown>[]): string {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(items));
  return path;
}

describe('selectSubset', () => {
  it('maps raw items to BenchQuestions joining sentences into document text', () => {
    const path = writeFixture('basic.json', [makeItem('q1'), makeItem('q2')]);

    const { questions } = selectSubset(path, 2, 1);

    expect(questions).toHaveLength(2);
    const byId = new Map(questions.map(q => [q.id, q]));
    const q1 = byId.get('q1')!;
    expect(q1.question).toBe('Question for q1?');
    expect(q1.answer).toBe('answer-q1');
    expect(q1.documents).toHaveLength(2);
    expect(q1.documents[0]).toEqual({
      title: 'q1-gold',
      text: 'First sentence for q1. Second sentence for q1.',
    });
  });

  it('takes only the first `size` items of the shuffle', () => {
    const items = Array.from({ length: 20 }, (_, i) => makeItem(`q${i}`));
    const path = writeFixture('sized.json', items);

    const { questions } = selectSubset(path, 5, 1);

    expect(questions).toHaveLength(5);
  });

  it('is deterministic for a seed and differs across seeds', () => {
    const items = Array.from({ length: 30 }, (_, i) => makeItem(`q${i}`));
    const path = writeFixture('seeds.json', items);

    const a = selectSubset(path, 10, 42);
    const b = selectSubset(path, 10, 42);
    const c = selectSubset(path, 10, 43);

    expect(a.questions.map(q => q.id)).toEqual(b.questions.map(q => q.id));
    expect(a.subsetHash).toBe(b.subsetHash);
    expect(a.questions.map(q => q.id)).not.toEqual(c.questions.map(q => q.id));
  });

  it('is a seeded shuffle of the full set, not the first N', () => {
    const items = Array.from({ length: 30 }, (_, i) => makeItem(`q${i}`));
    const path = writeFixture('shuffle.json', items);

    const { questions } = selectSubset(path, 10, 7);

    expect(questions.map(q => q.id)).not.toEqual(items.slice(0, 10).map(i => i._id));
  });

  it('returns a subset path and a sha256 hex hash', () => {
    const path = writeFixture('hash.json', [makeItem('q1')]);

    const { subsetPath, subsetHash } = selectSubset(path, 1, 1);

    expect(subsetPath).toContain('hotpotqa-subset-1-seed1.json');
    expect(subsetHash).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('SMOKE_QUESTIONS', () => {
  it('bundles three self-contained multi-hop items', () => {
    expect(SMOKE_QUESTIONS.map(q => q.id)).toEqual(['smoke-1', 'smoke-2', 'smoke-3']);
  });

  it('carries the gold answer somewhere in each item\'s documents', () => {
    for (const q of SMOKE_QUESTIONS) {
      const joined = q.documents.map(d => d.text).join(' ');
      expect(joined).toContain(q.answer);
    }
  });
});
