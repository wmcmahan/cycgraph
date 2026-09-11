/**
 * stats — the fleet's health, read from the recorded corpus.
 *
 * One row per workflow over a bounded window: how often runs complete,
 * how often their gates pass, whether lessons are actually reaching
 * prompts, what the reconciled outcomes say, what runs cost, and
 * whether the learning tail is degrading. Sense before propose: this
 * is the measurement any tuning starts from, and a health check
 * besides. Reads only what runs already recorded.
 *
 * @module maintenance/stats
 */

/** One workflow's aggregates over the window. */
export interface WorkflowStats {
  name: string;
  runs: number;
  completed: number;
  gateRan: number;
  gatePassed: number;
  withLessons: number;
  outcomes: number;
  avgScore: number | undefined;
  avgTokens: number | undefined;
  costUsd: number;
  tailFlags: number;
}

const pct = (part: number, whole: number): string =>
  whole === 0 ? '—' : `${Math.round((part / whole) * 100)}%`;

const compactTokens = (tokens: number | undefined): string =>
  tokens === undefined ? '—' : tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(Math.round(tokens));

/** Render the scorecard as aligned terminal lines. */
export function formatStats(rows: readonly WorkflowStats[], sinceDays: number): string[] {
  const lines = [
    `fleet scorecard — primary runs, last ${sinceDays} day(s)`,
    'workflow             runs  done  gate  lessons  outcomes  avg tok  cost     tail',
  ];
  for (const row of rows) {
    lines.push([
      row.name.padEnd(20),
      String(row.runs).padStart(4),
      pct(row.completed, row.runs).padStart(5),
      pct(row.gatePassed, row.gateRan).padStart(5),
      pct(row.withLessons, row.runs).padStart(8),
      (row.outcomes === 0 ? '—' : `${row.outcomes}@${(row.avgScore ?? 0).toFixed(2)}`).padStart(9),
      compactTokens(row.avgTokens).padStart(8),
      `$${row.costUsd.toFixed(2)}`.padStart(8),
      (row.tailFlags === 0 ? '' : ` ${row.tailFlags} degraded`),
    ].join(' '));
  }
  return lines;
}

/** Aggregate the recorded corpus per workflow over the window. */
export async function fetchStats(sinceDays: number): Promise<WorkflowStats[]> {
  const { withTenant, SEED_TENANT_ID, graphs, workflow_runs, workflow_states, run_outcomes } =
    await import('@cycgraph/orchestrator-postgres');
  const { sql } = await import('drizzle-orm');

  const rows = await withTenant(SEED_TENANT_ID, async (tx) => {
    const result = await tx.execute(sql`
      WITH latest AS (
        SELECT DISTINCT ON (ws.run_id) ws.run_id, ws.state
        FROM ${workflow_states} ws
        ORDER BY ws.run_id, ws.version DESC
      )
      SELECT g.name AS name,
        count(*)::int AS runs,
        count(*) FILTER (WHERE r.status = 'completed')::int AS completed,
        count(*) FILTER (WHERE l.state->'memory' ? 'gate_verification_passed')::int AS gate_ran,
        count(*) FILTER (WHERE (l.state->'memory'->>'gate_verification_passed')::boolean)::int AS gate_passed,
        count(*) FILTER (WHERE l.state->'lesson_provenance' <> '{}'::jsonb)::int AS with_lessons,
        count(o.run_id)::int AS outcomes,
        avg(o.score)::float AS avg_score,
        avg((l.state->>'total_tokens_used')::numeric)::float AS avg_tokens,
        coalesce(sum((l.state->>'total_cost_usd')::numeric), 0)::float AS cost_usd,
        count(*) FILTER (
          WHERE l.state->'memory'->'reflect_reflection'->>'extractor_failed' = 'true'
             OR l.state->'memory'->'reflect_reflection'->>'writer_failed' = 'true')::int AS tail_flags
      FROM ${workflow_runs} r
      JOIN ${graphs} g ON g.id = r.graph_id
      JOIN latest l ON l.run_id = r.id
      LEFT JOIN ${run_outcomes} o ON o.run_id = r.id::text
      WHERE r.run_kind = 'primary'
        AND r.created_at > now() - make_interval(days => ${sinceDays})
      GROUP BY g.name
      ORDER BY count(*) DESC`);
    return result.rows as unknown as {
      name: string; runs: number; completed: number; gate_ran: number; gate_passed: number;
      with_lessons: number; outcomes: number; avg_score: number | null;
      avg_tokens: number | null; cost_usd: number; tail_flags: number;
    }[];
  });

  return rows.map((row) => ({
    name: row.name,
    runs: row.runs,
    completed: row.completed,
    gateRan: row.gate_ran,
    gatePassed: row.gate_passed,
    withLessons: row.with_lessons,
    outcomes: row.outcomes,
    avgScore: row.avg_score ?? undefined,
    avgTokens: row.avg_tokens ?? undefined,
    costUsd: row.cost_usd,
    tailFlags: row.tail_flags,
  }));
}
