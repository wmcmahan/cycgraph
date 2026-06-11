import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryMemoryStore } from '../src/store/in-memory-store.js';
import { InMemoryOutcomeLedger } from '../src/consolidation/outcome-ledger.js';
import { retrieveGatedLessons } from '../src/retrieval/gated-lesson-retriever.js';
import type { SemanticFact } from '../src/schemas/semantic.js';
import type { Provenance } from '../src/schemas/provenance.js';

const prov: Provenance = { source: 'system', created_at: new Date() };
const TAG = 'graph:test-v1';

function makeLesson(
  id: string,
  status: 'candidate' | 'verified' | 'none',
  validFrom: Date,
  overrides: Partial<SemanticFact> = {},
): SemanticFact {
  const statusTags = status === 'none' ? [] : [status];
  return {
    id,
    content: `Lesson ${id}`,
    source_episode_ids: [],
    entity_ids: [],
    provenance: prov,
    valid_from: validFrom,
    tags: ['lesson', TAG, ...statusTags],
    ...overrides,
  };
}

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}

describe('retrieveGatedLessons', () => {
  let store: InMemoryMemoryStore;

  beforeEach(() => {
    store = new InMemoryMemoryStore();
  });

  it('fills verified-first with candidate exploration slots', async () => {
    for (let i = 0; i < 5; i++) {
      await store.putFact(makeLesson(`v${i}`, 'verified', daysAgo(i + 10)));
    }
    for (let i = 0; i < 4; i++) {
      await store.putFact(makeLesson(`c${i}`, 'candidate', daysAgo(i)));
    }

    const lessons = await retrieveGatedLessons(store, {
      tags: [TAG],
      max_facts: 5,
      candidate_slots: 2,
    });

    expect(lessons).toHaveLength(5);
    const candidates = lessons.filter((f) => f.tags.includes('candidate'));
    expect(candidates).toHaveLength(2);
    // Newest candidates win the exploration slots.
    expect(candidates.map((f) => f.id).sort()).toEqual(['c0', 'c1']);
  });

  it('falls back to extra verified lessons when few candidates exist', async () => {
    for (let i = 0; i < 6; i++) {
      await store.putFact(makeLesson(`v${i}`, 'verified', daysAgo(i)));
    }
    await store.putFact(makeLesson('c0', 'candidate', daysAgo(0)));

    const lessons = await retrieveGatedLessons(store, {
      tags: [TAG],
      max_facts: 5,
      candidate_slots: 3,
    });

    expect(lessons).toHaveLength(5);
    expect(lessons.filter((f) => f.tags.includes('candidate'))).toHaveLength(1);
    expect(lessons.filter((f) => !f.tags.includes('candidate'))).toHaveLength(4);
  });

  it('treats facts with no status tag as verified (pre-gate back-compat)', async () => {
    await store.putFact(makeLesson('legacy', 'none', daysAgo(1)));
    await store.putFact(makeLesson('c0', 'candidate', daysAgo(0)));

    const lessons = await retrieveGatedLessons(store, { tags: [TAG], max_facts: 5 });

    expect(lessons.map((f) => f.id).sort()).toEqual(['c0', 'legacy']);
  });

  it('excludes invalidated lessons', async () => {
    await store.putFact(makeLesson('evicted', 'candidate', daysAgo(0), { invalidated_by: 'eval-gate:harmful' }));
    await store.putFact(makeLesson('alive', 'candidate', daysAgo(1)));

    const lessons = await retrieveGatedLessons(store, { tags: [TAG] });
    expect(lessons.map((f) => f.id)).toEqual(['alive']);
  });

  it('candidate_slots: 0 retrieves verified only', async () => {
    await store.putFact(makeLesson('v0', 'verified', daysAgo(1)));
    await store.putFact(makeLesson('c0', 'candidate', daysAgo(0)));

    const lessons = await retrieveGatedLessons(store, { tags: [TAG], candidate_slots: 0 });
    expect(lessons.map((f) => f.id)).toEqual(['v0']);
  });

  it('caps candidate_slots at max_facts', async () => {
    for (let i = 0; i < 4; i++) {
      await store.putFact(makeLesson(`c${i}`, 'candidate', daysAgo(i)));
    }

    const lessons = await retrieveGatedLessons(store, {
      tags: [TAG],
      max_facts: 2,
      candidate_slots: 10,
    });
    expect(lessons).toHaveLength(2);
  });

  it('orders deterministically: valid_from desc with id tiebreak', async () => {
    const t = daysAgo(1);
    await store.putFact(makeLesson('bbb', 'verified', t));
    await store.putFact(makeLesson('aaa', 'verified', t));
    await store.putFact(makeLesson('newest', 'verified', daysAgo(0)));

    const lessons = await retrieveGatedLessons(store, { tags: [TAG], max_facts: 3, candidate_slots: 0 });
    expect(lessons.map((f) => f.id)).toEqual(['newest', 'aaa', 'bbb']);
  });

  it('scopes by tags — unrelated facts never appear', async () => {
    await store.putFact(makeLesson('in-scope', 'verified', daysAgo(0)));
    await store.putFact(makeLesson('out-of-scope', 'verified', daysAgo(0), { tags: ['other'] }));

    const lessons = await retrieveGatedLessons(store, { tags: [TAG] });
    expect(lessons.map((f) => f.id)).toEqual(['in-scope']);
  });

  it('selects candidates in-progress-first when a ledger is provided', async () => {
    // Three candidates; c-deep has 2 trials, c-started has 1, c-fresh
    // is newest with 0. In-progress candidates keep their slots so the
    // gate can rule on them; fresh ones queue behind.
    await store.putFact(makeLesson('c-deep', 'candidate', daysAgo(3)));
    await store.putFact(makeLesson('c-started', 'candidate', daysAgo(2)));
    await store.putFact(makeLesson('c-fresh', 'candidate', daysAgo(0)));

    const ledger = new InMemoryOutcomeLedger();
    await ledger.recordOutcome({ run_id: 'r1', score: 0.5, fact_ids: ['c-deep', 'c-started'] });
    await ledger.recordOutcome({ run_id: 'r2', score: 0.5, fact_ids: ['c-deep'] });

    const lessons = await retrieveGatedLessons(store, {
      tags: [TAG],
      max_facts: 2,
      candidate_slots: 2,
      ledger,
    });

    // Most trials win the slots: c-deep (2) and c-started (1); c-fresh (0) queues.
    expect(lessons.map((f) => f.id).sort()).toEqual(['c-deep', 'c-started']);
  });

  it('keeps a cohort stable as fresh candidates arrive every run', async () => {
    // Simulates the growth pattern that defeats newest- and
    // fewest-trials-first: one new candidate appears after each run.
    const ledger = new InMemoryOutcomeLedger();
    await store.putFact(makeLesson('c0', 'candidate', daysAgo(10)));
    await store.putFact(makeLesson('c1', 'candidate', daysAgo(9)));

    for (let run = 0; run < 3; run++) {
      const chosen = await retrieveGatedLessons(store, {
        tags: [TAG],
        max_facts: 2,
        candidate_slots: 2,
        ledger,
      });
      await ledger.recordOutcome({
        run_id: `run-${run}`,
        score: 0.5,
        fact_ids: chosen.map((f) => f.id),
      });
      // A fresh candidate lands after every run.
      await store.putFact(makeLesson(`fresh-${run}`, 'candidate', daysAgo(5 - run)));
    }

    // The original cohort accrued all three trials despite the influx.
    expect((await ledger.getFactStats('c0'))?.trials).toBe(3);
    expect((await ledger.getFactStats('c1'))?.trials).toBe(3);
    expect(await ledger.getFactStats('fresh-0')).toBeNull();
  });

  it('breaks trial-count ties oldest-first under a ledger', async () => {
    await store.putFact(makeLesson('older', 'candidate', daysAgo(5)));
    await store.putFact(makeLesson('newer', 'candidate', daysAgo(1)));

    const ledger = new InMemoryOutcomeLedger(); // both at 0 trials

    const lessons = await retrieveGatedLessons(store, {
      tags: [TAG],
      max_facts: 1,
      candidate_slots: 1,
      ledger,
    });

    expect(lessons.map((f) => f.id)).toEqual(['older']);
  });

  it('benches candidates at rest_after_trials so absence runs can form', async () => {
    await store.putFact(makeLesson('c-done', 'candidate', daysAgo(3)));
    await store.putFact(makeLesson('c-next', 'candidate', daysAgo(1)));

    const ledger = new InMemoryOutcomeLedger();
    await ledger.recordOutcome({ run_id: 'r1', score: 0.5, fact_ids: ['c-done'] });
    await ledger.recordOutcome({ run_id: 'r2', score: 0.5, fact_ids: ['c-done'] });

    const lessons = await retrieveGatedLessons(store, {
      tags: [TAG],
      max_facts: 2,
      candidate_slots: 2,
      ledger,
      rest_after_trials: 2,
    });

    // c-done finished its trial phase and rests; c-next takes the slot.
    expect(lessons.map((f) => f.id)).toEqual(['c-next']);
  });

  it('respects a custom candidate tag', async () => {
    await store.putFact(makeLesson('trial', 'none', daysAgo(0), { tags: ['lesson', TAG, 'on-trial'] }));
    await store.putFact(makeLesson('v0', 'verified', daysAgo(1)));

    const lessons = await retrieveGatedLessons(store, {
      tags: [TAG],
      candidate_tag: 'on-trial',
      max_facts: 1,
      candidate_slots: 1,
    });

    // The single slot goes to the candidate under the custom tag.
    expect(lessons.map((f) => f.id)).toEqual(['trial']);
  });
});
