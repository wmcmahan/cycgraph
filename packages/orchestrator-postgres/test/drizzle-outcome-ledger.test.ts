/**
 * DrizzleOutcomeLedger Tests
 *
 * Integration tests against a real Postgres instance.
 * Skipped automatically when DATABASE_URL is not set.
 *
 * The core proof is the parity suite: an identical sequence of outcomes is
 * fed to both InMemoryOutcomeLedger and DrizzleOutcomeLedger, and their
 * getFactStats / getBaseline / listFactStats must agree. If they do, the SQL
 * reproduces the in-memory contract, which is the whole point of the durable
 * substrate.
 */

import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { setupDatabaseTests, isDatabaseAvailable, getDb } from './setup.js';
import { DrizzleOutcomeLedger } from '../src/drizzle-outcome-ledger.js';
import { tenants } from '../src/schema.js';
import type { RetentionEvidence, RetentionReport } from '@cycgraph/memory';
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

function makeEvidence(overrides: Partial<RetentionEvidence> = {}): RetentionEvidence {
  return {
    lift: 0.3,
    se: 0.05,
    df: 8,
    pPromote: 0.98,
    pEvict: 0.01,
    trials: 5,
    baselineRuns: 5,
    ...overrides,
  };
}

describe.skipIf(!isDatabaseAvailable())('DrizzleOutcomeLedger', () => {
  setupDatabaseTests();
  const ledger = new DrizzleOutcomeLedger();

  describe('parity with InMemoryOutcomeLedger', () => {
    const F1 = randomUUID();
    const F2 = randomUUID();
    const F3 = randomUUID();

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

    const expectStatsEqual = (
      a: Awaited<ReturnType<DrizzleOutcomeLedger['getFactStats']>>,
      b: typeof a,
    ) => {
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

    it('getFactStats agrees for every fact', async () => {
      for (const f of [F1, F2, F3, 'never-injected']) {
        expectStatsEqual(await ledger.getFactStats(f), await mem.getFactStats(f));
      }
    });

    it('getBaseline agrees globally and leave-one-out', async () => {
      for (const exclude of [undefined, F1, F2, F3]) {
        const d = await ledger.getBaseline(exclude);
        const m = await mem.getBaseline(exclude);
        expect(d.runs).toBe(m.runs);
        expect(d.meanScore).toBeCloseTo(m.meanScore, 10);
        if (m.variance === undefined) expect(d.variance).toBeUndefined();
        else expect(d.variance).toBeCloseTo(m.variance, 10);
      }
    });

    it('listFactStats agrees in order and values', async () => {
      const d = await ledger.listFactStats();
      const m = await mem.listFactStats();
      expect(d.map((s) => s.factId)).toEqual(m.map((s) => s.factId));
      for (let i = 0; i < d.length; i++) expectStatsEqual(d[i], m[i]);
    });

    it('getFactStatsBatch agrees with per-id getFactStats and omits unseen ids', async () => {
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

  describe('recordOutcome', () => {
    it('is idempotent on run_id and replaces the earlier outcome', async () => {
      const f = randomUUID();
      await ledger.recordOutcome({ run_id: 'run-x', score: 0.2, fact_ids: [f] });
      await ledger.recordOutcome({ run_id: 'run-x', score: 0.9, fact_ids: [f] });

      const stats = await ledger.getFactStats(f);
      expect(stats?.trials).toBe(1);
      expect(stats?.meanScore).toBeCloseTo(0.9, 10);
      expect(stats?.variance).toBeUndefined();
    });

    it('dedups facts within a run and counts one trial', async () => {
      const f = randomUUID();
      await ledger.recordOutcome({ run_id: 'dup', score: 0.6, fact_ids: [f, f] });

      expect((await ledger.getFactStats(f))?.trials).toBe(1);
    });
  });

  describe('getFactStats', () => {
    it('reports undefined variance below 2 trials and the sample variance at 2+', async () => {
      const f = randomUUID();
      await ledger.recordOutcome({ run_id: 'a', score: 0.8, fact_ids: [f] });
      expect((await ledger.getFactStats(f))?.variance).toBeUndefined();

      await ledger.recordOutcome({ run_id: 'b', score: 0.4, fact_ids: [f] });
      expect((await ledger.getFactStats(f))?.variance).toBeCloseTo(0.08, 10);
    });

    it('returns null for a fact with no recorded outcomes', async () => {
      expect(await ledger.getFactStats(randomUUID())).toBeNull();
    });
  });

  describe('getBaseline', () => {
    it('returns runs 0 and mean 0 for an empty leave-one-out set', async () => {
      const f = randomUUID();
      await ledger.recordOutcome({ run_id: 'only', score: 0.7, fact_ids: [f] });

      expect(await ledger.getBaseline(f)).toEqual({ runs: 0, meanScore: 0 });
    });
  });

  describe('clear', () => {
    it('removes all outcomes', async () => {
      const f = randomUUID();
      await ledger.recordOutcome({ run_id: 'r', score: 0.5, fact_ids: [f] });

      await ledger.clear();

      expect(await ledger.getFactStats(f)).toBeNull();
      expect((await ledger.getBaseline()).runs).toBe(0);
    });
  });

  describe('evaluateRetention against the durable ledger', () => {
    it('promotes a lifting lesson and persists the audit trail', async () => {
      const store = new InMemoryMemoryStore();
      const good = randomUUID();
      await store.putFact(makeLesson(good));
      for (let i = 0; i < 5; i++) {
        await ledger.recordOutcome({ run_id: `with-${i}`, score: 0.9, fact_ids: [good] });
      }
      for (let i = 0; i < 5; i++) {
        await ledger.recordOutcome({ run_id: `without-${i}`, score: 0.5, fact_ids: [] });
      }

      const report = await evaluateRetention(store, ledger, { minTrials: 3 });

      expect(report.promoted.map((p) => p.factId)).toEqual([good]);
      expect((await store.getFact(good))?.tags).toContain('verified');

      await ledger.recordGateDecisions(report);
      const history = await ledger.getLessonHistory(good);
      expect(history).toHaveLength(1);
      expect(history[0].decision).toBe('promoted');
      expect(history[0].evidence?.lift).toBeCloseTo(0.4, 6);
      expect(history[0].trials).toBe(5);
    });
  });

  describe('recordGateDecisions', () => {
    it('persists promoted, evicted, and held rows with their evidence', async () => {
      const promoted = randomUUID();
      const evicted = randomUUID();
      const held = randomUUID();
      const report: RetentionReport = {
        promoted: [{ factId: promoted, evidence: makeEvidence({ alphaBracket: 2 }) }],
        evicted: [{ factId: evicted, reason: 'eval-gate:harmful', evidence: makeEvidence({ lift: -0.3 }) }],
        held: [{ factId: held, trials: 2, evidence: makeEvidence({ trials: 2 }) }],
      };

      await ledger.recordGateDecisions(report);

      const promotedRow = (await ledger.getLessonHistory(promoted))[0];
      expect(promotedRow.decision).toBe('promoted');
      expect(promotedRow.reason).toBeNull();
      expect(promotedRow.evidence?.alpha_bracket).toBe(2);
      expect(promotedRow.trials).toBe(5);

      const evictedRow = (await ledger.getLessonHistory(evicted))[0];
      expect(evictedRow.decision).toBe('evicted');
      expect(evictedRow.reason).toBe('eval-gate:harmful');
      expect(evictedRow.evidence?.alpha_bracket).toBeUndefined();

      const heldRow = (await ledger.getLessonHistory(held))[0];
      expect(heldRow.decision).toBe('held');
      expect(heldRow.trials).toBe(2);
    });

    it('omits evidence json when a decision has none', async () => {
      const held = randomUUID();

      await ledger.recordGateDecisions({ promoted: [], evicted: [], held: [{ factId: held, trials: 3 }] });

      const row = (await ledger.getLessonHistory(held))[0];
      expect(row.evidence).toBeNull();
      expect(row.trials).toBe(3);
    });

    it('writes nothing for an empty report', async () => {
      await ledger.recordGateDecisions({ promoted: [], evicted: [], held: [] });

      expect(await ledger.listGateDecisions()).toHaveLength(0);
    });
  });

  describe('listGateDecisions', () => {
    it('orders newest-first and filters by decision and fact', async () => {
      const a = randomUUID();
      const b = randomUUID();
      await ledger.recordGateDecisions(
        { promoted: [{ factId: a }], evicted: [{ factId: b, reason: 'eval-gate:harmful' }], held: [] },
        { gated_at: new Date(Date.UTC(2026, 0, 1)) },
      );
      await ledger.recordGateDecisions(
        { promoted: [], evicted: [], held: [{ factId: a, trials: 2 }] },
        { gated_at: new Date(Date.UTC(2026, 0, 2)) },
      );

      const all = await ledger.listGateDecisions();
      expect(all).toHaveLength(3);
      expect(all[0].decision).toBe('held');

      const evictions = await ledger.listGateDecisions({ decision: 'evicted' });
      expect(evictions).toHaveLength(1);
      expect(evictions[0].fact_id).toBe(b);
      expect(evictions[0].reason).toBe('eval-gate:harmful');

      const forA = await ledger.listGateDecisions({ factId: a });
      expect(forA.map((d) => d.decision).sort()).toEqual(['held', 'promoted']);
    });

    it('filters by reason', async () => {
      const a = randomUUID();
      const b = randomUUID();
      await ledger.recordGateDecisions({
        promoted: [],
        evicted: [
          { factId: a, reason: 'eval-gate:harmful' },
          { factId: b, reason: 'eval-gate:no_lift' },
        ],
        held: [],
      });

      const harmful = await ledger.listGateDecisions({ reason: 'eval-gate:harmful' });

      expect(harmful).toHaveLength(1);
      expect(harmful[0].fact_id).toBe(a);
    });

    it('filters by since timestamp', async () => {
      const a = randomUUID();
      const b = randomUUID();
      await ledger.recordGateDecisions(
        { promoted: [{ factId: a }], evicted: [], held: [] },
        { gated_at: new Date(Date.UTC(2026, 0, 1)) },
      );
      await ledger.recordGateDecisions(
        { promoted: [{ factId: b }], evicted: [], held: [] },
        { gated_at: new Date(Date.UTC(2026, 0, 5)) },
      );

      const recent = await ledger.listGateDecisions({ since: new Date(Date.UTC(2026, 0, 3)) });

      expect(recent.map((d) => d.fact_id)).toEqual([b]);
    });

    it('paginates with limit and offset', async () => {
      const f = randomUUID();
      for (let day = 1; day <= 3; day++) {
        await ledger.recordGateDecisions(
          { promoted: [{ factId: f }], evicted: [], held: [] },
          { gated_at: new Date(Date.UTC(2026, 0, day)) },
        );
      }

      const page1 = await ledger.listGateDecisions({ limit: 2, offset: 0 });
      const page2 = await ledger.listGateDecisions({ limit: 2, offset: 2 });

      expect(page1).toHaveLength(2);
      expect(page2).toHaveLength(1);
    });
  });

  describe('getFitnessTrend', () => {
    it('returns run scores in chronological order and honors since', async () => {
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

  describe('tenant scoping', () => {
    const TENANT_A = randomUUID();

    beforeAll(async () => {
      const db = await getDb();
      await db
        .insert(tenants)
        .values({ id: TENANT_A, slug: `led-${TENANT_A}`, name: 'Ledger Tenant' })
        .onConflictDoNothing();
    });

    afterAll(async () => {
      const db = await getDb();
      await db.delete(tenants).where(eq(tenants.id, TENANT_A));
    });

    const scoped = new DrizzleOutcomeLedger({ tenant: { tenant_id: TENANT_A } });

    it('records, aggregates, and audits within the tenant', async () => {
      const f = randomUUID();
      await scoped.recordOutcome({ run_id: `t-${randomUUID()}`, score: 0.8, fact_ids: [f] });
      await scoped.recordOutcome({ run_id: `t-${randomUUID()}`, score: 0.6, fact_ids: [f] });

      const stats = await scoped.getFactStats(f);
      expect(stats?.trials).toBe(2);
      expect(stats?.meanScore).toBeCloseTo(0.7, 10);

      expect((await scoped.getBaseline()).runs).toBe(2);
      expect((await scoped.getFactStatsBatch([f])).size).toBe(1);
      expect(await scoped.listFactStats()).toHaveLength(1);
      expect(await scoped.getFitnessTrend()).toHaveLength(2);

      await scoped.recordGateDecisions({ promoted: [{ factId: f, evidence: makeEvidence() }], evicted: [], held: [] });
      expect(await scoped.listGateDecisions({ factId: f })).toHaveLength(1);
      expect(await scoped.getLessonHistory(f)).toHaveLength(1);
    });
  });
});
