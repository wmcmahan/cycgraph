/**
 * reconcile-outcomes — human merge decisions, fed back as evidence.
 *
 * A maintenance run's own gate can only say whether the loop believed
 * its work; whether the PR MERGED is the ground truth, and it lives in
 * GitHub unrecorded. This reconciler walks recently recorded runs that
 * published a PR, asks gh what became of each, and records the verdict
 * on the outcome ledger against the lessons the run's prompts carried:
 * merged scores 1, closed-unmerged scores 0, still-open waits. A merge
 * verdict overwrites the run's gate-verdict outcome deliberately — the
 * human's decision is the stronger signal.
 *
 * This is the fitness ground truth the tune loop needs, and the sample
 * volume the lesson-retention gate is starved for.
 *
 * @module maintenance/reconcile
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getInjectedFactIds } from '@cycgraph/orchestrator';
import type { WorkflowState } from '@cycgraph/orchestrator';

const exec = promisify(execFile);

/** The PR number a publish result's URL points at, or `undefined`. */
export function prNumberFrom(prUrl: string): number | undefined {
  const match = /\/pull\/(\d+)(?:$|[/?#])/.exec(prUrl);
  return match ? Number(match[1]) : undefined;
}

/** MERGED scores 1, CLOSED-unmerged 0; anything else is undecided. */
export function mergeScore(prState: string): number | undefined {
  if (prState === 'MERGED') return 1;
  if (prState === 'CLOSED') return 0;
  return undefined;
}

/** One reconciled run, for the report. */
export interface ReconciledRun {
  runId: string;
  pr: number;
  state: string;
  score: number | undefined;
  factIds: number;
}

/** A published run's recorded facts, as the reconciler's query returns them. */
export interface PublishedRunRow {
  run_id: string;
  pr_url: string;
  lesson_provenance: unknown;
}

/** Ask gh for one PR's state; anything unreadable is undecided. */
async function ghPrState(repoRoot: string, pr: number): Promise<string> {
  try {
    const { stdout } = await exec(
      'gh', ['pr', 'view', String(pr), '--json', 'state'], { cwd: repoRoot });
    return String((JSON.parse(stdout) as { state?: string }).state ?? 'UNREADABLE');
  } catch {
    return 'UNREADABLE';
  }
}

/**
 * Score one batch of published-run rows against their PRs' fates. The
 * seam `reconcileOutcomes` runs on top of; pure given its two injected
 * effects, so the recording rules are pinnable without a database.
 */
export async function reconcileRows(
  rows: readonly PublishedRunRow[],
  options: {
    apply: boolean;
    readPrState: (pr: number) => Promise<string>;
    recordOutcome: (runId: string, score: number, factIds: string[]) => Promise<void>;
  },
): Promise<ReconciledRun[]> {
  const reconciled: ReconciledRun[] = [];
  for (const row of rows) {
    const pr = prNumberFrom(row.pr_url);
    if (pr === undefined) continue;

    const state = await options.readPrState(pr);
    const score = mergeScore(state);
    const factIds = getInjectedFactIds({ lesson_provenance: row.lesson_provenance } as WorkflowState);
    if (score !== undefined && options.apply) {
      await options.recordOutcome(row.run_id, score, factIds);
    }
    reconciled.push({ runId: row.run_id, pr, state, score, factIds: factIds.length });
  }
  return reconciled;
}

/**
 * Reconcile recent published runs against their PRs' fates.
 *
 * Reads recorded state through the tenant scope (the runtime role is
 * RLS-subject), asks gh per PR, and records decided outcomes through
 * the same ledger the lesson gate evaluates. Idempotent: re-running
 * re-records the same scores.
 */
export async function reconcileOutcomes(options: {
  repoRoot: string;
  sinceDays: number;
  apply: boolean;
  recordOutcome: (runId: string, score: number, factIds: string[]) => Promise<void>;
}): Promise<ReconciledRun[]> {
  const { withTenant, SEED_TENANT_ID, workflow_runs, workflow_states } =
    await import('@cycgraph/orchestrator-postgres');
  const { sql } = await import('drizzle-orm');

  const rows = await withTenant(SEED_TENANT_ID, async (tx) => {
    // run_kind 'primary' only: counterfactual forks inherit the parent's
    // publish_result and would each re-record the same merge verdict,
    // inflating the trial counts the retention gate divides by.
    const result = await tx.execute(sql`
      SELECT DISTINCT ON (ws.run_id)
        ws.run_id AS run_id,
        ws.state->'memory'->'publish_result'->>'prUrl' AS pr_url,
        ws.state->'lesson_provenance' AS lesson_provenance
      FROM ${workflow_states} ws
      JOIN ${workflow_runs} r ON r.id = ws.run_id
      WHERE r.status = 'completed'
        AND r.run_kind = 'primary'
        AND r.created_at > now() - make_interval(days => ${options.sinceDays})
        AND ws.state->'memory'->'publish_result'->>'prUrl' IS NOT NULL
      ORDER BY ws.run_id, ws.version DESC`);
    return result.rows as unknown as PublishedRunRow[];
  });

  return reconcileRows(rows, {
    apply: options.apply,
    readPrState: (pr) => ghPrState(options.repoRoot, pr),
    recordOutcome: options.recordOutcome,
  });
}
