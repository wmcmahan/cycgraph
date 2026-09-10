/**
 * opt-apply — implement one approved optimization ticket.
 *
 * The mechanical rung of the proposal ladder: an approved optimization
 * ticket already carries a verified diff, so implementing it needs no
 * model at all. The run re-applies that diff to a fresh clone,
 * re-benchmarks both sides the same aliased way, and only a change that
 * still measures — improved beyond floor and noise, nothing regressed,
 * checks green — becomes the PR that closes the ticket. A diff that no
 * longer applies, or an improvement the current tree no longer shows,
 * is refused honestly: the remedy is a fresh opt-propose run, not a
 * force.
 *
 * `--ticketFile` runs the same cycle from a saved ticket body, closing
 * nothing — how this is testable without GitHub.
 *
 * @module maintenance/opt-apply
 */

import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { graph, node, tool, verifier } from '@cycgraph/orchestrator';
import type { EvalAssertion } from '@cycgraph/orchestrator';
import { deliveryNodes, issueMarkers, listOpenIssues } from '@cycgraph/tools/git';
import { compareBench, runAliasedBench, type BenchRow } from './bench.js';
import { extractTicketDiff } from './proposal.js';
import { checksEnv, resolveRepo } from './repo.js';
import type { MaintenanceEnv, MaintenanceWorkflow } from './types.js';

const exec = promisify(execFile);

const params = z.object({
  repoRoot: z.string().default('')
    .describe('Repository the optimization lands in. Empty means the repository this runs inside'),
  label: z.string().default('maintenance-approved')
    .describe('Only tickets carrying this label are picked up — the human approval gate'),
  issueNumber: z.number().int().min(0).default(0)
    .describe('Apply this specific ticket. Zero picks the oldest approved one'),
  ticketFile: z.string().default('')
    .describe('Detached mode: read the ticket body from this file instead of GitHub; closes nothing'),
  target: z.string().default('')
    .describe('Vitest bench file filter for the re-measurement. Empty benches everything'),
  minImprovement: z.number().min(1).max(90).default(10)
    .describe('Percent improvement the re-measurement must still show'),
  checks: z.array(z.string()).default([])
    .describe('Commands that must pass before the PR, e.g. ["npm run lint"]'),
  commit: z.boolean().default(true)
    .describe('Commit the verified change. Off leaves the workspace for inspection'),
  publish: z.boolean().default(true)
    .describe('Push and open the PR. Off leaves the prepared publish script'),
});

type Params = z.infer<typeof params>;

/** The opt-apply workflow. */
export function optApply(): MaintenanceWorkflow<typeof params> {
  return {
    id: 'opt-apply',
    title: 'Implement one approved optimization ticket',
    covers: ['maintenance', 'optimization', 'issues'],
    requires: [],
    params,

    build: async (p: Params, env: MaintenanceEnv) => {
      const repoRoot = await resolveRepo(p.repoRoot);
      const workspaceAt = join(tmpdir(), `cycgraph-opt-apply-${randomUUID()}`);
      const token = env.publish?.token;

      const delivery = deliveryNodes({
        repoRoot,
        workspaceAt,
        branch: `opt/apply-${randomUUID().slice(0, 8)}`,
        title: 'perf: apply a measured optimization',
        detailFrom: 'verdict_result',
        evidence: (details: string[]) => ({
          summary: `An approved optimization ticket, re-verified by the opt-apply workflow. ${details.join(' ')}`.trim(),
          ...(details.length > 0 ? { changes: details } : {}),
          provenance: 'opt-apply: the ticket\'s verified diff was re-applied to a fresh clone and re-benchmarked; the improvement held beyond the floor and the noise, nothing regressed, and the checks passed.',
        }),
        commit: p.commit,
        publish: p.publish,
        ...(env.publish !== undefined ? { config: env.publish } : {}),
      });

      const pickTool = tool({
        name: 'pick_ticket',
        description: 'Pick the oldest approved optimization ticket and lift its verified diff.',
        parameters: z.object({}),
        timeoutMs: 60_000,
        execute: async () => {
          if (p.ticketFile !== '') {
            const body = await readFile(p.ticketFile, 'utf8');
            const diff = extractTicketDiff(body);
            return diff !== undefined
              ? { has_work: true, detached: true, diff }
              : { has_work: false, detail: 'the ticket file carries no complete ```diff block' };
          }
          const issues = await listOpenIssues(repoRoot, {
            label: p.label,
            ...(token !== undefined ? { token } : {}),
          });
          if (issues === undefined) {
            return { has_work: false, detail: 'cannot read the issue ledger and no --ticketFile was given' };
          }
          const candidates = issues
            .filter((issue) => p.issueNumber === 0 || issue.number === p.issueNumber)
            .filter((issue) => [...issueMarkers([issue])].some((key) => key.startsWith('optimization:')))
            .sort((a, b) => a.number - b.number);
          const picked = candidates[0];
          if (picked === undefined) {
            return { has_work: false, detail: `no open '${p.label}' optimization ticket` };
          }
          const diff = extractTicketDiff(picked.body);
          return diff !== undefined
            ? { has_work: true, issue_number: picked.number, diff }
            : { has_work: false, detail: `ticket #${picked.number} carries no complete diff — re-propose it` };
        },
      });

      const benchBeforeTool = tool({
        name: 'bench_before',
        description: 'Measure the baseline against the clone\'s own source.',
        parameters: z.object({}),
        timeoutMs: 1_800_000,
        execute: async () => ({ rows: await runAliasedBench(workspaceAt, { filter: p.target }) }),
      });

      const applyTool = tool({
        name: 'apply_diff',
        description: 'Apply the ticket\'s verified diff to the workspace.',
        parameters: z.object({ pick_result: z.unknown().optional() }),
        timeoutMs: 60_000,
        execute: async ({ pick_result }) => {
          const diff = (pick_result as { diff?: string } | undefined)?.diff ?? '';
          const patchAt = join(tmpdir(), `cycgraph-opt-apply-${randomUUID()}.patch`);
          await writeFile(patchAt, diff.endsWith('\n') ? diff : `${diff}\n`);
          try {
            await exec('git', ['apply', '--whitespace=nowarn', patchAt], { cwd: workspaceAt });
            return { applied: true };
          } catch (error) {
            return {
              applied: false,
              detail: `the diff no longer applies to the current tree — re-propose: ${(error as Error).message.split('\n')[0]}`,
            };
          }
        },
      });

      const benchAfterTool = tool({
        name: 'bench_after',
        description: 'Re-measure after the diff, the same way.',
        parameters: z.object({}),
        timeoutMs: 1_800_000,
        execute: async () => ({ rows: await runAliasedBench(workspaceAt, { filter: p.target }) }),
      });

      const verdictTool = tool({
        name: 'bench_verdict',
        description: 'Decide whether the improvement still holds.',
        parameters: z.object({
          pick_result: z.unknown().optional(),
          bench_before_result: z.unknown().optional(),
          bench_after_result: z.unknown().optional(),
        }),
        execute: async ({ pick_result, bench_before_result, bench_after_result }) => {
          const before = (bench_before_result as { rows?: BenchRow[] } | undefined)?.rows ?? [];
          const after = (bench_after_result as { rows?: BenchRow[] } | undefined)?.rows ?? [];
          const comparison = compareBench(before, after, p.minImprovement);
          const issue = (pick_result as { issue_number?: number } | undefined)?.issue_number;
          const closes = issue !== undefined ? `Closes #${issue}. ` : '';
          return {
            improved_count: comparison.improved.length,
            regressed_count: comparison.regressed.length,
            disappeared_count: comparison.disappeared.length,
            detail: comparison.disappeared.length > 0
              ? `${closes}benchmarks disappeared after the edit (broken or deleted, not a pass): ${comparison.disappeared.join(', ')}`
              : comparison.improved.length === 0
              ? `${closes}the improvement no longer measures ≥${p.minImprovement}% beyond noise`
              : comparison.regressed.length > 0
                ? `${closes}improvement holds but ${comparison.regressed.map((r) => r.id).join(', ')} regressed`
                : `${closes}re-verified: ${comparison.improved.map((d) => `${d.id} +${d.pct.toFixed(1)}%`).join('; ')}`,
          };
        },
      });

      const checksTool = tool({
        name: 'repo_checks',
        description: 'Run the repository\'s own checks in the workspace.',
        parameters: z.object({}),
        timeoutMs: 1_200_000,
        execute: async () => {
          if (p.checks.length === 0) return { clean: true, output: 'no checks configured' };
          try {
            await exec('sh', ['-c', p.checks.join(' && ')], { cwd: workspaceAt, env: checksEnv(), maxBuffer: 64 * 1024 * 1024 });
            return { clean: true, output: 'checks passed' };
          } catch (error) {
            return { clean: false, output: String((error as { stdout?: string }).stdout ?? (error as Error).message).slice(-2_000) };
          }
        },
      });

      const { clone, commit, publish } = delivery;
      const pick = node({ id: 'pick', type: 'tool', toolId: 'pick_ticket', tools: [pickTool], reads: [] });
      const benchBefore = node({ id: 'bench_before', type: 'tool', toolId: 'bench_before', tools: [benchBeforeTool], reads: [] });
      const apply = node({ id: 'apply', type: 'tool', toolId: 'apply_diff', tools: [applyTool], reads: [pick.result] });
      const benchAfter = node({ id: 'bench_after', type: 'tool', toolId: 'bench_after', tools: [benchAfterTool], reads: [] });
      const verdict = node({
        id: 'verdict',
        type: 'tool',
        toolId: 'bench_verdict',
        tools: [verdictTool],
        reads: [pick.result, benchBefore.result, benchAfter.result],
      });
      const checks = node({ id: 'checks', type: 'tool', toolId: 'repo_checks', tools: [checksTool], reads: [] });
      const gate = verifier.expression(
        `memory.${verdict.result}.improved_count >= 1 and memory.${verdict.result}.regressed_count == 0`
          + ` and memory.${checks.result}.clean`,
        {
          id: 'gate',
          reads: [verdict.result, checks.result],
          description: 'The measured improvement still holds, nothing regressed, and the checks pass',
        },
      );
      const report = node({ id: 'report', type: 'router' });

      return {
        graph: graph({
          name: 'opt-apply',
          description: 'Re-apply an approved optimization\'s verified diff and prove it still measures.',
          nodes: [clone, pick, benchBefore, apply, benchAfter, verdict, checks, gate, commit, publish, report],
          edges: [
            { from: clone, to: pick },
            { from: pick, to: benchBefore, when: `memory.${pick.result}.has_work` },
            { from: pick, to: report, when: `not memory.${pick.result}.has_work` },
            { from: benchBefore, to: apply },
            { from: apply, to: benchAfter, when: `memory.${apply.result}.applied` },
            { from: apply, to: report, when: `not memory.${apply.result}.applied` },
            { from: benchAfter, to: verdict },
            { from: verdict, to: checks },
            { from: checks, to: gate },
            { from: gate, to: commit, when: 'memory.gate_verification_passed' },
            // Nothing to retry mechanically: a diff that stopped measuring
            // needs a fresh proposal, not another identical application.
            { from: gate, to: report, when: 'not memory.gate_verification_passed' },
            { from: commit, to: publish },
            { from: publish, to: report },
          ],
          startNode: clone,
          endNodes: [report],
        }),
        input: { goal: 'Implement one approved optimization ticket.' },
        runner: {},
      };
    },

    evals: (): EvalAssertion[] => [
      { type: 'status_equals', expected: 'completed' },
      { type: 'memory_contains', key: 'pick_result' },
    ],
  };
}
