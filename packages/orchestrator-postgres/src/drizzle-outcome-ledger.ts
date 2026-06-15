/**
 * Drizzle Outcome Ledger
 *
 * Durable backing for `@cycgraph/memory`'s `OutcomeLedger` — the substrate
 * eval-gated learning needs to accumulate run-outcome evidence across
 * restarts (the in-memory ledger forgets it). Per-fact statistics and the
 * leave-one-out baseline are computed by SQL aggregation at query time
 * (`count` / `avg` / `var_samp`), reproducing `InMemoryOutcomeLedger`
 * exactly: `var_samp` is the (n−1) sample variance and is NULL for n < 2,
 * which maps to `variance: undefined`.
 *
 * Beyond the `OutcomeLedger` interface, this adapter is the observability
 * surface for the self-improving loop: it persists every retention-gate
 * decision with its statistical evidence (`gate_decisions`), and exposes
 * read APIs so an operator can audit what the system promoted, evicted, or
 * held — and why — plus the workflow's fitness trend over time.
 *
 * Mirrors `DrizzleMemoryStore` conventions: no constructor args, `getDb()`
 * per method, `db.transaction` + join-table sync for the run→fact link.
 *
 * @module @cycgraph/orchestrator-postgres/drizzle-outcome-ledger
 */

import { getDb } from './connection.js';
import { run_outcomes, run_outcome_facts, gate_decisions } from './schema.js';
import type { GateDecisionRow, RetentionEvidenceJson } from './schema.js';
import { eq, and, desc, asc, gte, count, avg, sql } from 'drizzle-orm';
import {
  RunOutcomeSchema,
  type OutcomeLedger,
  type RunOutcome,
  type FactStats,
  type OutcomeBaseline,
  type RetentionReport,
  type RetentionEvidence,
} from '@cycgraph/memory';

/** Filter for {@link DrizzleOutcomeLedger.listGateDecisions}. */
export interface GateDecisionFilter {
  fact_id?: string;
  decision?: 'promoted' | 'evicted' | 'held';
  reason?: string;
  /** Only decisions at or after this time. */
  since?: Date;
  limit?: number;
  offset?: number;
}

/** One point on the fitness trend (a scored run). */
export interface FitnessTrendPoint {
  run_id: string;
  score: number;
  recorded_at: Date;
}

/** `var_samp` over an empty/singleton set is NULL → `undefined`. */
function coerceVariance(raw: unknown): number | undefined {
  if (raw === null || raw === undefined) return undefined;
  const v = typeof raw === 'string' ? Number(raw) : (raw as number);
  return Number.isFinite(v) ? v : undefined;
}

function num(raw: unknown): number {
  const v = typeof raw === 'string' ? Number(raw) : (raw as number);
  return Number.isFinite(v) ? v : 0;
}

/**
 * Postgres-backed {@link OutcomeLedger} plus the eval-gating observability
 * surface.
 */
export class DrizzleOutcomeLedger implements OutcomeLedger {
  // ─── OutcomeLedger interface ──────────────────────────────────────────

  async recordOutcome(outcome: RunOutcome): Promise<void> {
    const parsed = RunOutcomeSchema.parse(outcome);
    const recordedAt = parsed.recorded_at ?? new Date();
    // Dedup fact_ids: the composite PK would reject duplicates, and the
    // in-memory ledger dedups within a run.
    const factIds = [...new Set(parsed.fact_ids)];

    const db = await getDb();
    await db.transaction(async (tx) => {
      // Idempotent on run_id — re-recording replaces the earlier outcome.
      await tx
        .insert(run_outcomes)
        .values({ run_id: parsed.run_id, score: parsed.score, recorded_at: recordedAt })
        .onConflictDoUpdate({
          target: run_outcomes.run_id,
          set: { score: parsed.score, recorded_at: recordedAt },
        });

      await tx.delete(run_outcome_facts).where(eq(run_outcome_facts.run_id, parsed.run_id));
      if (factIds.length > 0) {
        await tx
          .insert(run_outcome_facts)
          .values(factIds.map((fact_id) => ({ run_id: parsed.run_id, fact_id })));
      }
    });
  }

  async getFactStats(factId: string): Promise<FactStats | null> {
    const db = await getDb();
    const rows = await db
      .select({
        trials: count(),
        mean: avg(run_outcomes.score),
        variance: sql<number | null>`var_samp(${run_outcomes.score})`,
      })
      .from(run_outcomes)
      .innerJoin(run_outcome_facts, eq(run_outcome_facts.run_id, run_outcomes.run_id))
      .where(eq(run_outcome_facts.fact_id, factId));

    const trials = num(rows[0]?.trials);
    if (trials === 0) return null;
    const variance = coerceVariance(rows[0]?.variance);
    return {
      fact_id: factId,
      trials,
      mean_score: num(rows[0]?.mean),
      ...(variance !== undefined ? { variance } : {}),
    };
  }

  async getBaseline(excludeFactId?: string): Promise<OutcomeBaseline> {
    const db = await getDb();
    // Leave-one-out: runs that did NOT include `excludeFactId`.
    const whereClause =
      excludeFactId === undefined
        ? undefined
        : sql`NOT EXISTS (
            SELECT 1 FROM ${run_outcome_facts} rf
            WHERE rf.run_id = ${run_outcomes.run_id} AND rf.fact_id = ${excludeFactId}
          )`;

    const base = db
      .select({
        runs: count(),
        mean: avg(run_outcomes.score),
        variance: sql<number | null>`var_samp(${run_outcomes.score})`,
      })
      .from(run_outcomes);

    const rows = await (whereClause ? base.where(whereClause) : base);
    const runs = num(rows[0]?.runs);
    const variance = coerceVariance(rows[0]?.variance);
    return {
      runs,
      mean_score: runs === 0 ? 0 : num(rows[0]?.mean),
      ...(variance !== undefined ? { variance } : {}),
    };
  }

  async listFactStats(): Promise<FactStats[]> {
    const db = await getDb();
    const rows = await db
      .select({
        fact_id: run_outcome_facts.fact_id,
        trials: count(),
        mean: avg(run_outcomes.score),
        variance: sql<number | null>`var_samp(${run_outcomes.score})`,
      })
      .from(run_outcome_facts)
      .innerJoin(run_outcomes, eq(run_outcomes.run_id, run_outcome_facts.run_id))
      .groupBy(run_outcome_facts.fact_id)
      .orderBy(asc(run_outcome_facts.fact_id));

    return rows.map((r) => {
      const variance = coerceVariance(r.variance);
      return {
        fact_id: r.fact_id,
        trials: num(r.trials),
        mean_score: num(r.mean),
        ...(variance !== undefined ? { variance } : {}),
      };
    });
  }

  async clear(): Promise<void> {
    const db = await getDb();
    // FK cascade removes run_outcome_facts when run_outcomes is cleared,
    // but delete it explicitly so the call works regardless of FK timing.
    await db.delete(run_outcome_facts);
    await db.delete(run_outcomes);
  }

  // ─── Observability surface ────────────────────────────────────────────

  /**
   * Persist a retention-gate pass to the audit log. **Append-only**:
   * re-running the gate logs new rows each pass (that history is the
   * point), so this is intentionally not idempotent.
   */
  async recordGateDecisions(
    report: RetentionReport,
    opts?: { gated_at?: Date },
  ): Promise<void> {
    const gatedAt = opts?.gated_at ?? new Date();
    const rows: Array<typeof gate_decisions.$inferInsert> = [];

    const evidenceJson = (e?: RetentionEvidence): RetentionEvidenceJson | null =>
      e
        ? {
            lift: e.lift,
            se: e.se,
            df: e.df,
            p_promote: e.p_promote,
            p_evict: e.p_evict,
            trials: e.trials,
            baseline_runs: e.baseline_runs,
            ...(e.alpha_bracket !== undefined ? { alpha_bracket: e.alpha_bracket } : {}),
          }
        : null;

    for (const p of report.promoted) {
      rows.push({
        fact_id: p.fact_id,
        decision: 'promoted',
        reason: null,
        evidence: evidenceJson(p.evidence),
        trials: p.evidence?.trials ?? null,
        gated_at: gatedAt,
      });
    }
    for (const e of report.evicted) {
      rows.push({
        fact_id: e.fact_id,
        decision: 'evicted',
        reason: e.reason,
        evidence: evidenceJson(e.evidence),
        trials: e.evidence?.trials ?? null,
        gated_at: gatedAt,
      });
    }
    for (const h of report.held) {
      rows.push({
        fact_id: h.fact_id,
        decision: 'held',
        reason: null,
        evidence: evidenceJson(h.evidence),
        trials: h.trials,
        gated_at: gatedAt,
      });
    }

    if (rows.length === 0) return;
    const db = await getDb();
    await db.insert(gate_decisions).values(rows);
  }

  /** Recent gate decisions, newest first, filterable for audit views. */
  async listGateDecisions(filter: GateDecisionFilter = {}): Promise<GateDecisionRow[]> {
    const db = await getDb();
    const conditions = [];
    if (filter.fact_id) conditions.push(eq(gate_decisions.fact_id, filter.fact_id));
    if (filter.decision) conditions.push(eq(gate_decisions.decision, filter.decision));
    if (filter.reason) conditions.push(eq(gate_decisions.reason, filter.reason));
    if (filter.since) conditions.push(gte(gate_decisions.gated_at, filter.since));

    const query = db.select().from(gate_decisions);
    const where = conditions.length > 0 ? and(...conditions) : undefined;
    return (where ? query.where(where) : query)
      .orderBy(desc(gate_decisions.gated_at), desc(gate_decisions.id))
      .limit(filter.limit ?? 100)
      .offset(filter.offset ?? 0);
  }

  /** Full decision history for one lesson, oldest first. */
  async getLessonHistory(factId: string): Promise<GateDecisionRow[]> {
    const db = await getDb();
    return db
      .select()
      .from(gate_decisions)
      .where(eq(gate_decisions.fact_id, factId))
      .orderBy(asc(gate_decisions.gated_at), asc(gate_decisions.id));
  }

  /** Recent run scores in chronological order — the workflow's fitness trend. */
  async getFitnessTrend(opts: { since?: Date; limit?: number } = {}): Promise<FitnessTrendPoint[]> {
    const db = await getDb();
    const query = db
      .select({
        run_id: run_outcomes.run_id,
        score: run_outcomes.score,
        recorded_at: run_outcomes.recorded_at,
      })
      .from(run_outcomes);
    const rows = await (opts.since ? query.where(gte(run_outcomes.recorded_at, opts.since)) : query)
      .orderBy(asc(run_outcomes.recorded_at))
      .limit(opts.limit ?? 500);
    return rows;
  }
}
