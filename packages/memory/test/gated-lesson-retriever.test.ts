/**
 * Tests for retrieval/gated-lesson-retriever: verified-first retrieval with
 * reserved candidate exploration slots and ledger-driven cohort ordering.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryMemoryStore } from '../src/store/in-memory-store.js';
import { InMemoryOutcomeLedger } from '../src/consolidation/outcome-ledger.js';
import { retrieveGatedLessons } from '../src/retrieval/gated-lesson-retriever.js';
import type { OutcomeLedger } from '../src/consolidation/outcome-ledger.js';
import type { SemanticFact } from '../src/schemas/semantic.js';
import { FIXED_DATE, makeFact } from './helpers.js';

const TAG = 'graph:test-v1';

function makeLesson(
  id: string,
  status: 'candidate' | 'verified' | 'none',
  validFrom: Date,
  overrides: Partial<SemanticFact> = {},
): SemanticFact {
  const statusTags = status === 'none' ? [] : [status];
  return makeFact({
    id,
    content: `Lesson ${id}`,
    valid_from: validFrom,
    tags: ['lesson', TAG, ...statusTags],
    ...overrides,
  });
}

function daysAgo(n: number): Date {
  return new Date(FIXED_DATE.getTime() - n * 24 * 60 * 60 * 1000);
}

function ledgerWithoutBatch(trialsById: Record<string, number>): OutcomeLedger {
  return {
    async recordOutcome() {},
    async getFactStats(id: string) {
      const trials = trialsById[id];
      return trials === undefined ? null : { factId: id, trials, meanScore: 0.5 };
    },
    async listFactStats() {
      return [];
    },
    async getBaseline() {
      return { runs: 0, meanScore: 0 };
    },
    async clear() {},
  };
}

describe('retrieveGatedLessons', () => {
  let store: InMemoryMemoryStore;

  beforeEach(() => {
    store = new InMemoryMemoryStore();
  });

  it('fills verified lessons first and reserves candidate exploration slots', async () => {
    for (let i = 0; i < 5; i++) {
      await store.putFact(makeLesson(`v${i}`, 'verified', daysAgo(i + 10)));
    }
    for (let i = 0; i < 4; i++) {
      await store.putFact(makeLesson(`c${i}`, 'candidate', daysAgo(i)));
    }

    const lessons = await retrieveGatedLessons(store, { tags: [TAG], maxFacts: 5, candidateSlots: 2 });

    const candidates = lessons.filter((f) => f.tags.includes('candidate'));
    expect(lessons).toHaveLength(5);
    expect(candidates.map((f) => f.id).sort()).toEqual(['c0', 'c1']);
  });

  it('backfills unused candidate slots with extra verified lessons', async () => {
    for (let i = 0; i < 6; i++) {
      await store.putFact(makeLesson(`v${i}`, 'verified', daysAgo(i)));
    }
    await store.putFact(makeLesson('c0', 'candidate', daysAgo(0)));

    const lessons = await retrieveGatedLessons(store, { tags: [TAG], maxFacts: 5, candidateSlots: 3 });

    expect(lessons.filter((f) => f.tags.includes('candidate'))).toHaveLength(1);
    expect(lessons.filter((f) => !f.tags.includes('candidate'))).toHaveLength(4);
  });

  it('treats facts with no status tag as verified', async () => {
    await store.putFact(makeLesson('legacy', 'none', daysAgo(1)));
    await store.putFact(makeLesson('c0', 'candidate', daysAgo(0)));

    const lessons = await retrieveGatedLessons(store, { tags: [TAG], maxFacts: 5 });

    expect(lessons.map((f) => f.id).sort()).toEqual(['c0', 'legacy']);
  });

  it('excludes invalidated lessons', async () => {
    await store.putFact(makeLesson('evicted', 'candidate', daysAgo(0), { invalidated_by: 'eval-gate:harmful' }));
    await store.putFact(makeLesson('alive', 'candidate', daysAgo(1)));

    const lessons = await retrieveGatedLessons(store, { tags: [TAG] });

    expect(lessons.map((f) => f.id)).toEqual(['alive']);
  });

  it('retrieves verified lessons only when candidateSlots is 0', async () => {
    await store.putFact(makeLesson('v0', 'verified', daysAgo(1)));
    await store.putFact(makeLesson('c0', 'candidate', daysAgo(0)));

    const lessons = await retrieveGatedLessons(store, { tags: [TAG], candidateSlots: 0 });

    expect(lessons.map((f) => f.id)).toEqual(['v0']);
  });

  it('caps candidateSlots at maxFacts', async () => {
    for (let i = 0; i < 4; i++) {
      await store.putFact(makeLesson(`c${i}`, 'candidate', daysAgo(i)));
    }

    const lessons = await retrieveGatedLessons(store, { tags: [TAG], maxFacts: 2, candidateSlots: 10 });

    expect(lessons).toHaveLength(2);
  });

  it('orders verified lessons newest-first with an id tiebreak', async () => {
    const sameDay = daysAgo(1);
    await store.putFact(makeLesson('bbb', 'verified', sameDay));
    await store.putFact(makeLesson('aaa', 'verified', sameDay));
    await store.putFact(makeLesson('newest', 'verified', daysAgo(0)));

    const lessons = await retrieveGatedLessons(store, { tags: [TAG], maxFacts: 3, candidateSlots: 0 });

    expect(lessons.map((f) => f.id)).toEqual(['newest', 'aaa', 'bbb']);
  });

  it('scopes retrieval to the requested tags', async () => {
    await store.putFact(makeLesson('in-scope', 'verified', daysAgo(0)));
    await store.putFact(makeLesson('out-of-scope', 'verified', daysAgo(0), { tags: ['other'] }));

    const lessons = await retrieveGatedLessons(store, { tags: [TAG] });

    expect(lessons.map((f) => f.id)).toEqual(['in-scope']);
  });

  it('selects candidates most-trials-first when a ledger is provided', async () => {
    await store.putFact(makeLesson('c-deep', 'candidate', daysAgo(3)));
    await store.putFact(makeLesson('c-started', 'candidate', daysAgo(2)));
    await store.putFact(makeLesson('c-fresh', 'candidate', daysAgo(0)));

    const ledger = new InMemoryOutcomeLedger();
    await ledger.recordOutcome({ run_id: 'r1', score: 0.5, fact_ids: ['c-deep', 'c-started'] });
    await ledger.recordOutcome({ run_id: 'r2', score: 0.5, fact_ids: ['c-deep'] });

    const lessons = await retrieveGatedLessons(store, { tags: [TAG], maxFacts: 2, candidateSlots: 2, ledger });

    expect(lessons.map((f) => f.id).sort()).toEqual(['c-deep', 'c-started']);
  });

  it('selects candidates most-trials-first when the ledger has no batch method', async () => {
    await store.putFact(makeLesson('c-more', 'candidate', daysAgo(3)));
    await store.putFact(makeLesson('c-less', 'candidate', daysAgo(2)));

    const ledger = ledgerWithoutBatch({ 'c-more': 2, 'c-less': 1 });

    const lessons = await retrieveGatedLessons(store, { tags: [TAG], maxFacts: 1, candidateSlots: 1, ledger });

    expect(lessons.map((f) => f.id)).toEqual(['c-more']);
  });

  it('treats a candidate with no ledger record as zero trials under a non-batch ledger', async () => {
    await store.putFact(makeLesson('c-known', 'candidate', daysAgo(3)));
    await store.putFact(makeLesson('c-unknown', 'candidate', daysAgo(2)));

    const ledger = ledgerWithoutBatch({ 'c-known': 2 });

    const lessons = await retrieveGatedLessons(store, { tags: [TAG], maxFacts: 1, candidateSlots: 1, ledger });

    expect(lessons.map((f) => f.id)).toEqual(['c-known']);
  });

  it('breaks ties by id when candidates share valid_from and trial count under a ledger', async () => {
    const sameDay = daysAgo(2);
    await store.putFact(makeLesson('c-bbb', 'candidate', sameDay));
    await store.putFact(makeLesson('c-aaa', 'candidate', sameDay));

    const ledger = new InMemoryOutcomeLedger();

    const lessons = await retrieveGatedLessons(store, { tags: [TAG], maxFacts: 1, candidateSlots: 1, ledger });

    expect(lessons.map((f) => f.id)).toEqual(['c-aaa']);
  });

  it('keeps a trial cohort stable as fresh candidates arrive every run', async () => {
    const ledger = new InMemoryOutcomeLedger();
    await store.putFact(makeLesson('c0', 'candidate', daysAgo(10)));
    await store.putFact(makeLesson('c1', 'candidate', daysAgo(9)));

    for (let run = 0; run < 3; run++) {
      const chosen = await retrieveGatedLessons(store, { tags: [TAG], maxFacts: 2, candidateSlots: 2, ledger });
      await ledger.recordOutcome({ run_id: `run-${run}`, score: 0.5, fact_ids: chosen.map((f) => f.id) });
      await store.putFact(makeLesson(`fresh-${run}`, 'candidate', daysAgo(5 - run)));
    }

    expect((await ledger.getFactStats('c0'))?.trials).toBe(3);
    expect((await ledger.getFactStats('c1'))?.trials).toBe(3);
    expect(await ledger.getFactStats('fresh-0')).toBeNull();
  });

  it('breaks trial-count ties oldest-first under a ledger', async () => {
    await store.putFact(makeLesson('older', 'candidate', daysAgo(5)));
    await store.putFact(makeLesson('newer', 'candidate', daysAgo(1)));

    const ledger = new InMemoryOutcomeLedger();

    const lessons = await retrieveGatedLessons(store, { tags: [TAG], maxFacts: 1, candidateSlots: 1, ledger });

    expect(lessons.map((f) => f.id)).toEqual(['older']);
  });

  it('benches candidates that reach restAfterTrials so absence runs can form', async () => {
    await store.putFact(makeLesson('c-done', 'candidate', daysAgo(3)));
    await store.putFact(makeLesson('c-next', 'candidate', daysAgo(1)));

    const ledger = new InMemoryOutcomeLedger();
    await ledger.recordOutcome({ run_id: 'r1', score: 0.5, fact_ids: ['c-done'] });
    await ledger.recordOutcome({ run_id: 'r2', score: 0.5, fact_ids: ['c-done'] });

    const lessons = await retrieveGatedLessons(store, {
      tags: [TAG],
      maxFacts: 2,
      candidateSlots: 2,
      ledger,
      restAfterTrials: 2,
    });

    expect(lessons.map((f) => f.id)).toEqual(['c-next']);
  });

  it('honors a custom candidate tag', async () => {
    await store.putFact(makeLesson('trial', 'none', daysAgo(0), { tags: ['lesson', TAG, 'on-trial'] }));
    await store.putFact(makeLesson('v0', 'verified', daysAgo(1)));

    const lessons = await retrieveGatedLessons(store, {
      tags: [TAG],
      candidateTag: 'on-trial',
      maxFacts: 1,
      candidateSlots: 1,
    });

    expect(lessons.map((f) => f.id)).toEqual(['trial']);
  });

  it('returns an empty list when no lesson matches the scope tags', async () => {
    await store.putFact(makeLesson('elsewhere', 'verified', daysAgo(0), { tags: ['lesson', 'graph:other'] }));

    const lessons = await retrieveGatedLessons(store, { tags: [TAG] });

    expect(lessons).toEqual([]);
  });

  it('never retrieves a quarantined lesson', async () => {
    await store.putFact(makeLesson('good', 'verified', daysAgo(1)));
    await store.putFact(
      makeLesson('poisoned', 'verified', daysAgo(0), { tags: ['lesson', TAG, 'verified', 'quarantined'] }),
    );

    const lessons = await retrieveGatedLessons(store, { tags: [TAG], maxFacts: 5, candidateSlots: 2 });

    const ids = lessons.map((f) => f.id);
    expect(ids).toContain('good');
    expect(ids).not.toContain('poisoned');
  });
});
