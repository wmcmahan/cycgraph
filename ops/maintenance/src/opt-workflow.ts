/**
 * opt-propose — optimization proposals with measured evidence.
 *
 * The proposal tier's measurable half. An agent studies the benchmark
 * baseline, makes one optimization in a jailed clone, and the harness
 * re-benches: the verdict passes only when at least one benchmark
 * improves beyond the floor and the noise, none regresses, and every
 * changed file sits inside the allowed scope. What a passing run
 * produces is a *ticket*, not a PR — the issue carries the proposal,
 * the measured table, and the verified diff, and waits for a human to
 * approve. Filing follows the ledger rules: marker-keyed, deduped, and
 * refused when the ledger cannot be read.
 *
 * @module maintenance/opt-workflow
 */

import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { agent, graph, node, tool, verifier } from '@cycgraph/orchestrator';
import type { EvalAssertion } from '@cycgraph/orchestrator';
import {
  cloneToBranch,
  createIssue,
  findingMarker,
  issueMarkers,
  listOpenIssues,
  pendingDiff,
} from '@cycgraph/tools/git';
import {
  createWorkspaceSession,
  diagnosticsTool,
  editFileTool,
  readFileTool,
  searchTool,
} from '@cycgraph/tools/workspace';
import { compareBench, runAliasedBench, type BenchComparison, type BenchRow } from './bench.js';
import { resolveRepo } from './repo.js';
import type { MaintenanceEnv, MaintenanceWorkflow } from './types.js';

const params = z.object({
  repoRoot: z.string().default('')
    .describe('Repository whose hot paths are optimized. Empty means the repository this runs inside'),
  target: z.string().default('')
    .describe('Vitest bench file filter, e.g. "reducer". Empty benches everything'),
  minImprovement: z.number().min(1).max(90).default(10)
    .describe('Percent throughput improvement a proposal must measure to be worth a ticket'),
  scope: z.string().default('packages/orchestrator/src')
    .describe('Directory the optimization may touch; changes outside it are refused'),
  checks: z.array(z.string()).default([])
    .describe('Commands that must pass before a proposal may be filed, e.g. ["npm run lint"]'),
  attempts: z.number().int().min(1).max(8).default(3)
    .describe('Optimization attempts before the run gives up; each re-benches'),
  file: z.boolean().default(true)
    .describe('File the verified proposal as an issue. Off reports the verdict and diff only'),
  prompt: z.string().default('')
    .describe('Override the optimizer agent\'s instructions'),
  budgetTokens: z.number().int().min(0).default(400000)
    .describe('Hard token budget for the run; breach fails the run. Zero removes the cap'),
});

type Params = z.infer<typeof params>;

function benchTable(rows: readonly BenchRow[], limit: number): string {
  return rows.slice(0, limit)
    .map((row) => `${row.id}: ${Math.round(row.hz).toLocaleString('en-US')} ops/s (±${row.rme.toFixed(2)}%)`)
    .join('\n');
}

function keyFor(comparison: BenchComparison, files: readonly string[]): string {
  const top = [...comparison.improved].sort((a, b) => b.pct - a.pct)[0];
  const normalize = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `optimization:${normalize(top?.id ?? 'none').slice(0, 60)}:${normalize(files.join('+')).slice(0, 60)}`;
}

/** The opt-propose workflow. */
export function optPropose(): MaintenanceWorkflow<typeof params> {
  return {
    id: 'opt-propose',
    title: 'Propose one measured optimization as a ticket',
    covers: ['maintenance', 'optimization', 'workspace'],
    params,

    build: async (p: Params, env: MaintenanceEnv) => {
      const repoRoot = await resolveRepo(p.repoRoot);
      const session = createWorkspaceSession();
      const workspaceAt = join(tmpdir(), `cycgraph-opt-${randomUUID()}`);
      const token = env.publish?.token;

      const hands = {
        read: readFileTool({ root: workspaceAt, session }),
        search: searchTool({ root: workspaceAt }),
        edit: editFileTool({ root: workspaceAt, session }),
      };

      const cloneTool = tool({
        name: 'clone_repo',
        description: 'Clone the repository into a disposable workspace.',
        parameters: z.object({}),
        execute: async () => {
          const ws = await cloneToBranch(repoRoot, `opt/scan-${randomUUID().slice(0, 8)}`, { at: workspaceAt });
          return { workspace: ws.root };
        },
      });

      const benchBeforeTool = tool({
        name: 'bench_before',
        description: 'Measure the baseline against the clone\'s own source.',
        parameters: z.object({}),
        timeoutMs: 1_800_000,
        execute: async () => {
          const rows = await runAliasedBench(workspaceAt, { filter: p.target });
          return { rows, summary: benchTable(rows, 30) };
        },
      });

      const benchAfterTool = tool({
        name: 'bench_after',
        description: 'Re-measure after the edit, the same way.',
        parameters: z.object({}),
        timeoutMs: 1_800_000,
        execute: async () => ({ rows: await runAliasedBench(workspaceAt, { filter: p.target }) }),
      });

      const verdictTool = tool({
        name: 'bench_verdict',
        description: 'Compare the runs and check the diff stayed in scope.',
        parameters: z.object({
          bench_before_result: z.unknown().optional(),
          bench_after_result: z.unknown().optional(),
        }),
        timeoutMs: 60_000,
        execute: async ({ bench_before_result, bench_after_result }) => {
          const before = (bench_before_result as { rows?: BenchRow[] } | undefined)?.rows ?? [];
          const after = (bench_after_result as { rows?: BenchRow[] } | undefined)?.rows ?? [];
          const comparison = compareBench(before, after, p.minImprovement);

          const { stdout } = await promisify(execFile)(
            'git', ['diff', '--name-only'], { cwd: workspaceAt },
          );
          const changed = stdout.split('\n').filter(Boolean);
          const outOfScope = changed.filter((file) => !file.startsWith(`${p.scope}/`) && file !== p.scope);

          const detail = changed.length === 0
            ? 'nothing was changed'
            : outOfScope.length > 0
              ? `changes left the allowed scope: ${outOfScope.join(', ')}`
              : comparison.improved.length === 0
                ? `no benchmark improved by ≥${p.minImprovement}% beyond noise`
                : comparison.regressed.length > 0
                  ? `improved ${comparison.improved.length} but regressed ${comparison.regressed.map((r) => r.id).join(', ')}`
                  : `improved ${comparison.improved.map((d) => `${d.id} +${d.pct.toFixed(1)}%`).join('; ')}`;

          return {
            ...comparison,
            improved_count: comparison.improved.length,
            regressed_count: comparison.regressed.length,
            out_of_scope_count: outOfScope.length,
            changed_count: changed.length,
            changed_files: changed,
            detail,
          };
        },
      });

      const checksTool = diagnosticsTool({
        name: 'repo_checks',
        cwd: workspaceAt,
        command: p.checks.length > 0 ? 'sh' : 'true',
        ...(p.checks.length > 0 ? { args: ['-c', p.checks.join(' && ')] } : { args: [] }),
        timeoutMs: 600_000,
      });

      const ticketTool = tool({
        name: 'file_ticket',
        description: 'File the verified proposal as a marker-keyed, deduped issue.',
        parameters: z.object({
          verdict_result: z.unknown().optional(),
          proposal: z.unknown().optional(),
        }),
        timeoutMs: 120_000,
        execute: async ({ verdict_result, proposal }) => {
          const verdict = verdict_result as (BenchComparison & { changed_files?: string[]; detail?: string }) | undefined;
          const files = verdict?.changed_files ?? [];
          const key = keyFor(verdict ?? { improved: [], regressed: [], unchanged: 0 }, files);
          const diff = await pendingDiff(workspaceAt);
          if (!p.file) return { filed: false, key, detail: 'dry run', diff };

          const issues = await listOpenIssues(repoRoot, token !== undefined ? { token } : {});
          if (issues === undefined) {
            return { filed: false, key, diff, detail: 'cannot read the issue ledger — refusing to file blind' };
          }
          if (issueMarkers(issues).has(key)) {
            return { filed: false, key, detail: 'an open ticket already carries this proposal' };
          }

          const top = [...(verdict?.improved ?? [])].sort((a, b) => b.pct - a.pct)[0];
          const outcome = await createIssue(repoRoot, {
            title: `[optimization] ${top !== undefined ? `${top.id} +${top.pct.toFixed(1)}%` : 'measured proposal'}`,
            body: [
              String(proposal ?? '(no description)'),
              '',
              `Measured: ${verdict?.detail ?? ''}`,
              '',
              'Verified diff (re-verified and applied by the opt-apply workflow on approval):',
              '```diff',
              diff.length > 60_000 ? `${diff.slice(0, 60_000)}\n… (truncated)` : diff,
              '```',
              '',
              'Proposed by the opt-propose workflow. Approve with the `maintenance-approved` label.',
              '',
              findingMarker(key),
            ].join('\n'),
          }, token !== undefined ? { token } : {});
          return 'url' in outcome
            ? { filed: true, key, url: outcome.url, detail: `filed ${outcome.url}` }
            : { filed: false, key, diff, detail: `could not file: ${outcome.error}` };
        },
      });

      const optimizer = agent({
        id: 'optimizer',
        name: 'Optimization proposer',
        model: env.model,
        provider: env.provider,
        temperature: 0.2,
        maxSteps: 24,
        instructions: p.prompt !== '' ? p.prompt : [
          `You optimize one hot path in a codebase. The baseline benchmark table is in your context; the code lives under ${p.scope}.`,
          'Pick ONE benchmark with headroom, find the code it exercises, and make one focused change that plausibly raises its throughput: avoid redundant copies, hoist invariant work, cheapen the common case.',
          'Never change what the code computes — a benchmark that got faster by doing less is a regression in disguise and will be caught.',
          `Only edit files under ${p.scope}. Use search to orient, read_file for exact bytes, edit_file to change them; the find text must match exactly once.`,
          'If a previous attempt is reported as not improving, revert your thinking, pick a different bottleneck, and try a different change.',
          'When your edit is made, reply with one short paragraph starting PROPOSAL: naming the benchmark you targeted, the change, and why it is faster.',
        ].join(' '),
        tools: [hands.search, hands.read, hands.edit],
      });

      const clone = node({ id: 'clone', type: 'tool', toolId: 'clone_repo', tools: [cloneTool] });
      const benchBefore = node({
        id: 'bench_before',
        type: 'tool',
        toolId: 'bench_before',
        tools: [benchBeforeTool],
        reads: [],
      });
      const propose = node({
        id: 'propose',
        agent: optimizer,
        failurePolicy: { timeoutMs: 1_200_000 },
        reads: [benchBefore.result, 'verdict_result'],
        writes: 'proposal',
      });
      const benchAfter = node({
        id: 'bench_after',
        type: 'tool',
        toolId: 'bench_after',
        tools: [benchAfterTool],
        reads: [],
      });
      const verdict = node({
        id: 'verdict',
        type: 'tool',
        toolId: 'bench_verdict',
        tools: [verdictTool],
        reads: [benchBefore.result, benchAfter.result],
      });
      const checks = node({ id: 'checks', type: 'tool', toolId: 'repo_checks', tools: [checksTool], reads: [] });
      const gate = verifier.expression(
        `memory.${verdict.result}.improved_count >= 1 and memory.${verdict.result}.regressed_count == 0`
          + ` and memory.${verdict.result}.out_of_scope_count == 0 and memory.${checks.result}.clean`,
        {
          id: 'gate',
          reads: [verdict.result, checks.result],
          description: 'At least one benchmark measurably improved, none regressed, and the change stayed in scope',
        },
      );
      const ticket = node({
        id: 'ticket',
        type: 'tool',
        toolId: 'file_ticket',
        tools: [ticketTool],
        reads: [verdict.result, 'proposal'],
      });
      const report = node({ id: 'report', type: 'router' });

      return {
        graph: graph({
          name: 'opt-propose',
          description: 'Measure, optimize, re-measure; a verified improvement becomes a ticket.',
          nodes: [clone, benchBefore, propose, benchAfter, verdict, checks, gate, ticket, report],
          edges: [
            { from: clone, to: benchBefore },
            { from: benchBefore, to: propose },
            { from: propose, to: benchAfter },
            { from: benchAfter, to: verdict },
            { from: verdict, to: checks },
            { from: checks, to: gate },
            { from: gate, to: ticket, when: 'memory.gate_verification_passed' },
            { from: gate, to: propose, when: 'not memory.gate_verification_passed' },
            { from: ticket, to: report },
          ],
          startNode: clone,
          endNodes: [report],
        }),
        input: { goal: 'Propose one measured optimization.',
          ...(p.budgetTokens > 0 ? { maxTokenBudget: p.budgetTokens } : {}), maxIterations: 6 + p.attempts * 6 },
        runner: {},
      };
    },

    evals: (): EvalAssertion[] => [
      { type: 'status_equals', expected: 'completed' },
      { type: 'memory_contains', key: 'verdict_result' },
    ],
  };
}
