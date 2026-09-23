/**
 * sense_target — read the scorecard and the target's recent failures.
 *
 * The sensor: it reads the fleet scorecard and the target workflow's recent
 * failures and gate refusals from the recorded corpus, so the analyst
 * proposes against real measured misbehavior rather than a guess.
 *
 * @module maintenance/tune/tools/sense
 */

import { z } from 'zod';
import { tool } from '@cycgraph/orchestrator';
import { fetchStats, formatStats } from '../../shared/stats.js';
import type { TuneContext } from '../context.js';

/** The corpus-sensing tool, bound to the run's context. */
export function senseTool(c: TuneContext) {
  const { params: p, sourceDir } = c;
  return tool({
    name: 'sense_target',
    description: 'Read the scorecard and the target workflow\'s recent failures from the corpus.',
    parameters: z.object({}),
    timeoutMs: 120_000,
    execute: async () => {
      const stats = await fetchStats(14);
      const row = stats.find((entry) => entry.name === p.target);
      const { withTenant, SEED_TENANT_ID, graphs, workflow_runs, workflow_states } =
        await import('@cycgraph/orchestrator-postgres');
      const { sql } = await import('drizzle-orm');
      const failures = await withTenant(SEED_TENANT_ID, async (tx) => {
        const result = await tx.execute(sql`
          WITH latest AS (
            SELECT DISTINCT ON (ws.run_id) ws.run_id, ws.state
            FROM ${workflow_states} ws ORDER BY ws.run_id, ws.version DESC
          )
          SELECT r.status AS status,
            l.state->'memory'->>'gate_verification_passed' AS gate,
            left(l.state->'memory'->'judge_result'->>'detail', 200) AS judge,
            left(l.state->'memory'->'sift_result'->>'drops', 400) AS drops
          FROM ${workflow_runs} r
          JOIN ${graphs} g ON g.id = r.graph_id
          JOIN latest l ON l.run_id = r.id
          WHERE g.name = ${p.target} AND r.run_kind = 'primary'
            AND (r.status <> 'completed' OR (l.state->'memory'->>'gate_verification_passed') = 'false')
          ORDER BY r.created_at DESC LIMIT 8`);
        return result.rows as { status: string; gate: string | null; judge: string | null; drops: string | null }[];
      });
      return {
        has_signal: row !== undefined,
        scorecard: row !== undefined ? formatStats([row], 14).join('\n') : `no ${p.target} runs recorded in the window`,
        recent_failures: failures,
        instruction: [
          `Target workflow: ${p.target}. Its source lives under ${sourceDir}/ (the file names match the workflow id, e.g. audit-workflow.ts, docs-workflow.ts, feature-propose.ts).`,
          'Scorecard (last 14 days):',
          row !== undefined ? formatStats([row], 14).join('\n') : '(no runs recorded)',
          failures.length > 0
            ? `Recent failures and gate refusals:\n${failures.map((f, i) => `${i + 1}. status=${f.status} gate=${f.gate ?? '—'} ${f.judge ?? ''} ${f.drops ?? ''}`).join('\n')}`
            : 'No recent failures — look for efficiency or robustness improvements the instructions leave on the table.',
        ].join('\n'),
      };
    },
  });
}
