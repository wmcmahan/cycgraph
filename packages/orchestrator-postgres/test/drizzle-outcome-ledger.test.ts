/**
 * DrizzleOutcomeLedger Tests
 *
 * Integration tests against a real Postgres instance.
 * Skipped automatically when DATABASE_URL is not set.
 *
 * The core proof is the PARITY suite: an identical sequence of outcomes is
 * fed to both InMemoryOutcomeLedger and DrizzleOutcomeLedger, and their
 * getFactStats / getBaseline / listFactStats must agree. If they do, the SQL
 * reproduces the in-memory contract — which is the whole point of the
 * durable substrate.
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { setupDatabaseTests, isDatabaseAvailable } from './setup.js';
import { DrizzleOutcomeLedger } from '../src/drizzle-outcome-ledger.js';
import {
  InMemoryOutcomeLedger,
  InMemoryMemoryStore,
  evaluateRetention,
  type RunOutcome,
  type SemanticFact,
  type Provenance,
} from '@cycgraph/memory';

const prov: Provenance = { source: 'system', created_at: new Date() };

function makeLesson(id: string, overrides: Partial<SemanticFact> = {}): SemanticFact {
  return {
    id,
    content: `Lesson ${id}`,
    source_episode_ids: [],
    entity_ids: [],
    provenance: prov,
    valid_from: new Date(),
    tags: ['lesson', 'candidate'],
    ...overrides,
  };
}

describe.skipIf(!isDatabaseAvailable())('DrizzleOutcomeLedger', () => {
  setupDatabaseTests();
  const ledger = new DrizzleOutcomeLedger();

  // ── Parity vs InMemoryOutcomeLedger ──

  describe('parity with InMemoryOutcomeLedger', () => {
    const F1 = randomUUID();
    const F2 = randomUUID();
    const F3 = randomUUID();

    // A varied sequence: overlapping facts, a lesson-free run, a re-record.
    const outcomes: RunOutcome[] = [
      { run_id: 'r1', score: 0.9, fact_ids: [F1, F2] },
      { run_id: 'r2', score: 0.4, fact_ids: [F1] },
      { run_id: 'r3', score: 0.6, fact_ids: [] },
      { run_id: 'r4', score: 0.8, fact_ids: [F2, F3] },
      { run_id: 'r5', score: 0.2, fact_ids: [F3] },
    ];

    let mem: InMemoryOutcomeLedger;

    beforeEach(async () => {
      mem = new InMemoryOutcomeLedger();
      for (const o of outcomes) {
        await mem.recordOutcome(o);
        await ledger.recordOutcome(o);
      }
    });

    const expectStatsEqual = (a: Awaited<ReturnType<DrizzleOutcomeLedger['getFactStats']>>, b: typeof a) => {
      if (a === null || b === null) {
        expect(a).toBe(b);
        return;
      }
      expect(a.factId).toBe(b.factId);
      expect(a.trials).toBe(b.trials);
      expect(a.meanScore).toBeCloseTo(b.meanScore, 10);
      if (a.variance === undefined || b.variance === undefined) {
        expect(a.variance).toBe(b.variance);
      } else {
        expect(a.variance).toBeCloseTo(b.variance, 10);
      }
    };

    test('getFactStats agrees for every fact', async () => {
      for (const f of [F1, F2, F3, 'never-injected']) {
        expectStatsEqual(await ledger.getFactStats(f), await mem.getFactStats(f));
      }
    });

    test('getBaseline (global and leave-one-out) agrees', async () => {
      for (const exclude of [undefined, F1, F2, F3]) {
        const d = await ledger.getBaseline(exclude);
        const m = await mem.getBaseline(exclude);
        expect(d.runs).toBe(m.runs);
        expect(d.meanScore).toBeCloseTo(m.meanScore, 10);
        if (m.variance === undefined) expect(d.variance).toBeUndefined();
        else expect(d.variance).toBeCloseTo(m.variance, 10);
      }
    });

    test('listFactStats agrees (same order, same values)', async () => {
      const d = await ledger.listFactStats();
      const m = await mem.listFactStats();
      expect(d.map((s) => s.factId)).toEqual(m.map((s) => s.factId));
      for (let i = 0; i < d.length; i++) expectStatsEqual(d[i], m[i]);
    });

    test('getFactStatsBatch agrees with per-id getFactStats and omits unseen ids', async () => {
      const unseen = randomUUID();
      const d = await ledger.getFactStatsBatch([F1, F2, F3, unseen]);
      const m = await mem.getFactStatsBatch([F1, F2, F3, unseen]);
      expect([...d.keys()].sort()).toEqual([...m.keys()].sort());
      expect(d.has(unseen)).toBe(false);
      for (const f of [F1, F2, F3]) {
        expectStatsEqual(d.get(f) ?? null, await ledger.getFactStats(f));
      }
      expect(await ledger.getFactStatsBatch([])).toEqual(new Map());
    });
  });

  // ── Ledger semantics ──

  test('is idempotent on run_id — re-recording replaces the outcome', async () => {
    const f = randomUUID();
    await ledger.recordOutcome({ run_id: 'run-x', score: 0.2, fact_ids: [f] });
    await ledger.recordOutcome({ run_id: 'run-x', score: 0.9, fact_ids: [f] });
    const stats = await ledger.getFactStats(f);
    expect(stats?.trials).toBe(1);
    expect(stats?.meanScore).toBeCloseTo(0.9, 10);
    expect(stats?.variance).toBeUndefined();
  });

  test('variance is undefined at fewer than 2 trials, present at 2+', async () => {
    const f = randomUUID();
    await ledger.recordOutcome({ run_id: 'a', score: 0.8, fact_ids: [f] });
    expect((await ledger.getFactStats(f))?.variance).toBeUndefined();
    await ledger.recordOutcome({ run_id: 'b', score: 0.4, fact_ids: [f] });
    // (0.2² + 0.2²) / 1 = 0.08
    expect((await ledger.getFactStats(f))?.variance).toBeCloseTo(0.08, 10);
  });

  test('empty leave-one-out baseline returns {runs:0, mean_score:0}', async () => {
    const f = randomUUID();
    await ledger.recordOutcome({ run_id: 'only', score: 0.7, fact_ids: [f] });
    expect(await ledger.getBaseline(f)).toEqual({ runs: 0, meanScore: 0 });
  });

  test('dedups facts within a run (composite PK), counting one trial', async () => {
    const f = randomUUID();
    await ledger.recordOutcome({ run_id: 'dup', score: 0.6, fact_ids: [f, f] });
    expect((await ledger.getFactStats(f))?.trials).toBe(1);
  });

  test('clear() removes all outcomes', async () => {
    const f = randomUUID();
    await ledger.recordOutcome({ run_id: 'r', score: 0.5, fact_ids: [f] });
    await ledger.clear();
    expect(await ledger.getFactStats(f)).toBeNull();
    expect((await ledger.getBaseline()).runs).toBe(0);
  });

  // ── The durable ledger drives the real gate, end to end ──

  test('evaluateRetention works against the durable ledger and the report persists', async () => {
    const store = new InMemoryMemoryStore();
    const good = randomUUID();
    await store.putFact(makeLesson(good));

    // Big lift, enough trials, with a leave-one-out baseline to compare against.
    for (let i = 0; i < 5; i++) {
      await ledger.recordOutcome({ run_id: `with-${i}`, score: 0.9, fact_ids: [good] });
    }
    for (let i = 0; i < 5; i++) {
      await ledger.recordOutcome({ run_id: `without-${i}`, score: 0.5, fact_ids: [] });
    }

    const report = await evaluateRetention(store, ledger, { minTrials: 3 });
    expect(report.promoted.map((p) => p.factId)).toEqual([good]);
    expect((await store.getFact(good))?.tags).toContain('verified');

    // Persist the audit trail and read it back.
    await ledger.recordGateDecisions(report);
    const history = await ledger.getLessonHistory(good);
    expect(history).toHaveLength(1);
    expect(history[0].decision).toBe('promoted');
    expect(history[0].evidence?.lift).toBeCloseTo(0.4, 6);
    expect(history[0].trials).toBe(5);
  });

  // ── Observability surface ──

  test('listGateDecisions filters and orders newest-first', async () => {
    const a = randomUUID();
    const b = randomUUID();
    await ledger.recordGateDecisions(
      {
        promoted: [{ factId: a }],
        evicted: [{ factId: b, reason: 'eval-gate:harmful' }],
        held: [],
      },
      { gated_at: new Date(Date.UTC(2026, 0, 1)) },
    );
    await ledger.recordGateDecisions(
      { promoted: [], evicted: [], held: [{ factId: a, trials: 2 }] },
      { gated_at: new Date(Date.UTC(2026, 0, 2)) },
    );

    const all = await ledger.listGateDecisions();
    expect(all).toHaveLength(3);
    // Newest first.
    expect(all[0].decision).toBe('held');

    const evictions = await ledger.listGateDecisions({ decision: 'evicted' });
    expect(evictions).toHaveLength(1);
    expect(evictions[0].fact_id).toBe(b);
    expect(evictions[0].reason).toBe('eval-gate:harmful');

    const forA = await ledger.listGateDecisions({ factId: a });
    expect(forA.map((d) => d.decision).sort()).toEqual(['held', 'promoted']);
  });

  test('getFitnessTrend returns run scores in chronological order', async () => {
    await ledger.recordOutcome({ run_id: 'r1', score: 0.3, fact_ids: [], recorded_at: new Date(Date.UTC(2026, 0, 1)) });
    await ledger.recordOutcome({ run_id: 'r2', score: 0.7, fact_ids: [], recorded_at: new Date(Date.UTC(2026, 0, 2)) });
    await ledger.recordOutcome({ run_id: 'r3', score: 0.9, fact_ids: [], recorded_at: new Date(Date.UTC(2026, 0, 3)) });

    const trend = await ledger.getFitnessTrend();
    expect(trend.map((p) => p.runId)).toEqual(['r1', 'r2', 'r3']);
    expect(trend.map((p) => p.score)).toEqual([0.3, 0.7, 0.9]);

    const recent = await ledger.getFitnessTrend({ since: new Date(Date.UTC(2026, 0, 2)) });
    expect(recent.map((p) => p.runId)).toEqual(['r2', 'r3']);
  });
});
