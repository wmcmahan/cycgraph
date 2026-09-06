/**
 * issue-fix — the fix cycle over approved upkeep issues.
 *
 * core-upkeep files what the codebase owes; a human approves an issue
 * by labelling it; this workflow does the work. One issue per run: pick
 * the oldest approved issue carrying a finding marker, re-locate the
 * finding in a fresh clone (an issue whose finding is already gone
 * routes to a clean exit), fix it with an agent, judge with the class's
 * anti-gaming guard (`issue-judge.ts`), run the repository's checks,
 * and deliver one PR whose body closes the issue. The human gates are
 * the label going in and the merge coming out.
 *
 * With no readable ledger, `--key` runs the same cycle detached — the
 * finding named directly, nothing closed — which is what makes the
 * loop testable without GitHub.
 *
 * @module maintenance/issue-fix
 */

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { agent, graph, node, tool, verifier } from '@cycgraph/orchestrator';
import type { EvalAssertion } from '@cycgraph/orchestrator';
import { deliveryNodes, listOpenIssues, pendingDiff } from '@cycgraph/tools/git';
import {
  createWorkspaceSession,
  diagnosticsTool,
  editFileTool,
  readFileTool,
  searchTool,
} from '@cycgraph/tools/workspace';
import { scanCore, type CoreFinding } from './core-scan.js';
import { judgeIssueFix, parseIssueFinding, type IssueFinding } from './issue-judge.js';
import { resolveRepo } from './repo.js';
import type { MaintenanceEnv, MaintenanceWorkflow } from './types.js';

const params = z.object({
  repoRoot: z.string().default('')
    .describe('Repository whose approved upkeep is fixed. Empty means the repository this runs inside'),
  label: z.string().default('maintenance-approved')
    .describe('Only issues carrying this label are picked up — the human approval gate'),
  issueNumber: z.number().int().min(0).default(0)
    .describe('Fix this specific issue. Zero picks the oldest approved one'),
  key: z.string().default('')
    .describe('Detached mode: fix this finding key directly, without reading or closing any issue'),
  checks: z.array(z.string()).default([])
    .describe('Commands that must pass before a fix may be committed, e.g. ["npm run lint"]'),
  lint: z.boolean().default(true)
    .describe('Include the eslint sense class in the baseline and judge scans'),
  commit: z.boolean().default(true)
    .describe('Commit the verified fix to a branch. Off leaves the workspace for inspection'),
  publish: z.boolean().default(true)
    .describe('Push the committed branch to origin and open a pull request'),
  prompt: z.string().default('')
    .describe('Override the fixer agent\'s instructions. Empty uses the built-in prompt'),
  budgetTokens: z.number().int().min(0).default(300000)
    .describe('Hard token budget for the run; breach fails the run. Zero removes the cap'),
});

type Params = z.infer<typeof params>;

const GUIDANCE: Record<CoreFinding['kind'], string> = {
  todo: 'Do the work the comment describes, then remove the comment. Removing the comment without doing the work will be refused.',
  'skipped-test': 'Remove the .skip so the test runs, and make it pass by fixing whatever it exercises. Deleting the test will be refused.',
  'lint-warning': 'Fix the code the warning points at. Adding an eslint-disable comment or touching lint configuration will be refused.',
};

/** The issue-fix workflow. */
export function issueFix(): MaintenanceWorkflow<typeof params> {
  return {
    id: 'issue-fix',
    title: 'Fix one approved upkeep issue',
    covers: ['maintenance', 'upkeep', 'workspace'],
    params,

    build: async (p: Params, env: MaintenanceEnv) => {
      const repoRoot = await resolveRepo(p.repoRoot);
      const session = createWorkspaceSession();
      const workspaceAt = join(tmpdir(), `cycgraph-issue-fix-${randomUUID()}`);
      const branchName = `upkeep/fix-${randomUUID().slice(0, 8)}`;
      const token = env.publish?.token;

      const hands = {
        read: readFileTool({ root: workspaceAt, session }),
        search: searchTool({ root: workspaceAt }),
        edit: editFileTool({ root: workspaceAt, session }),
      };

      const delivery = deliveryNodes({
        repoRoot,
        workspaceAt,
        branch: branchName,
        title: 'chore: resolve owed upkeep',
        detailFrom: 'judge_result',
        evidence: (details: string[]) => ({
          summary: `Found by core-upkeep, approved by label, fixed by the issue-fix workflow. ${details.join(' ')}`.trim(),
          ...(details.length > 0 ? { changes: details } : {}),
          provenance: 'issue-fix: the finding was re-located mechanically, fixed by an agent in a jailed clone, and verified by re-scan, a class-specific anti-gaming guard, and repository checks before commit.',
        }),
        commit: p.commit,
        publish: p.publish,
        ...(env.publish !== undefined ? { config: env.publish } : {}),
      });

      const pickTool = tool({
        name: 'pick_issue',
        description: 'Pick the oldest approved upkeep issue, or run detached on a named key.',
        parameters: z.object({}),
        timeoutMs: 60_000,
        execute: async () => {
          const issues = await listOpenIssues(repoRoot, {
            label: p.label,
            ...(token !== undefined ? { token } : {}),
          });
          if (issues !== undefined) {
            const candidates = issues
              .filter((issue) => p.issueNumber === 0 || issue.number === p.issueNumber)
              .flatMap((issue) => {
                const finding = parseIssueFinding(issue.body);
                return finding !== undefined ? [{ issue, finding }] : [];
              })
              .sort((a, b) => a.issue.number - b.issue.number);
            const picked = candidates[0];
            if (picked === undefined) {
              return { has_work: false, detail: `no open '${p.label}' issue carries a finding marker` };
            }
            return { has_work: true, issue_number: picked.issue.number, ...picked.finding };
          }
          if (p.key !== '') {
            const kind = p.key.slice(0, p.key.indexOf(':'));
            const file = p.key.slice(p.key.indexOf(':') + 1, p.key.lastIndexOf(':'));
            return { has_work: true, detached: true, key: p.key, kind, file };
          }
          return { has_work: false, detail: 'cannot read the issue ledger and no --key was given' };
        },
      });

      const baselineTool = tool({
        name: 'baseline_scan',
        description: 'Re-locate the picked finding in the clone and record the before state.',
        parameters: z.object({ pick_result: z.unknown().optional() }),
        timeoutMs: 300_000,
        execute: async ({ pick_result }) => {
          const pick = pick_result as { key?: string; issue_number?: number } | undefined;
          const findings = await scanCore(workspaceAt, { lint: p.lint });
          const target = findings.find((finding) => finding.key === pick?.key);
          if (target === undefined) {
            return {
              has_target: false,
              keys: findings.map((f) => f.key),
              detail: `'${pick?.key ?? ''}' is not present in the current tree — the issue may already be resolved; close it by hand`,
            };
          }
          const text = await readFile(join(workspaceAt, target.file), 'utf8').catch(() => '');
          return {
            has_target: true,
            keys: findings.map((f) => f.key),
            target,
            text,
            instruction: [
              `In ${target.file}, line ${target.line}: ${target.detail}`,
              GUIDANCE[target.kind],
              'Change nothing unrelated.',
            ].join('\n'),
          };
        },
      });

      const judgeTool = tool({
        name: 'judge_fix',
        description: 'Re-scan and decide whether the finding was resolved without gaming its class.',
        parameters: z.object({
          pick_result: z.unknown().optional(),
          baseline_result: z.unknown().optional(),
        }),
        timeoutMs: 300_000,
        execute: async ({ pick_result, baseline_result }) => {
          const pick = pick_result as { issue_number?: number } | undefined;
          const baseline = baseline_result as
            { keys?: string[]; target?: CoreFinding; text?: string } | undefined;
          const target = baseline?.target;
          if (target === undefined) return { resolved: false, weakened: false, detail: 'nothing was targeted' };

          const finding: IssueFinding = { key: target.key, kind: target.kind, file: target.file };
          const after = await scanCore(workspaceAt, { lint: p.lint });
          const afterText = await readFile(join(workspaceAt, target.file), 'utf8').catch(() => '');
          const verdict = judgeIssueFix({
            finding,
            beforeKeys: baseline?.keys ?? [],
            afterKeys: after.map((f) => f.key),
            text: { before: baseline?.text ?? '', after: afterText },
            diff: await pendingDiff(workspaceAt),
          });
          // "Closes #N" in the verdict detail reaches the PR body through
          // the delivery evidence, which is what closes the issue on merge.
          const closes = pick?.issue_number !== undefined ? `Closes #${pick.issue_number}. ` : '';
          return { ...verdict, detail: `${closes}${verdict.detail}` };
        },
      });

      const checksTool = diagnosticsTool({
        name: 'repo_checks',
        cwd: workspaceAt,
        command: p.checks.length > 0 ? 'sh' : 'true',
        ...(p.checks.length > 0 ? { args: ['-c', p.checks.join(' && ')] } : { args: [] }),
        timeoutMs: 600_000,
      });

      const fixer = agent({
        id: 'upkeep-fixer',
        name: 'Upkeep fixer',
        model: env.model,
        provider: env.provider,
        temperature: 0.1,
        maxSteps: 16,
        instructions: p.prompt !== '' ? p.prompt : [
          'You resolve one piece of owed upkeep in a codebase: a TODO to implement, a skipped test to revive, or a lint warning to fix.',
          'Use search to orient, read_file to see exact bytes, and edit_file to change them.',
          'The find text must be the file’s exact bytes as read_file shows them: never include line-number prefixes from search results, and never change indentation.',
          'If edit_file refuses because the find text matches more than one place, read the file and retry with a longer find that includes enough neighbouring text to match exactly once.',
          'Resolve the work, never erase its marker: the follow-up instruction states what counts as erasure for this finding, and erasure is refused.',
          'Change nothing unrelated. When the fix is made, reply with one line: FIXED <file>.',
        ].join(' '),
        tools: [hands.search, hands.read, hands.edit],
      });

      const { clone, commit, publish } = delivery;
      const pick = node({ id: 'pick', type: 'tool', toolId: 'pick_issue', tools: [pickTool], reads: [] });
      const baseline = node({
        id: 'baseline',
        type: 'tool',
        toolId: 'baseline_scan',
        tools: [baselineTool],
        reads: [pick.result],
      });
      const fix = node({
        id: 'fix',
        agent: fixer,
        reads: [baseline.result, 'judge_result'],
        writes: 'fix_report',
      });
      const judge = node({
        id: 'judge',
        type: 'tool',
        toolId: 'judge_fix',
        tools: [judgeTool],
        reads: [pick.result, baseline.result],
      });
      const checks = node({ id: 'checks', type: 'tool', toolId: 'repo_checks', tools: [checksTool], reads: [] });
      const gate = verifier.expression(
        `memory.${judge.result}.resolved and not memory.${judge.result}.weakened`
          + ` and memory.${judge.result}.introduced_count == 0 and memory.${checks.result}.clean`,
        {
          id: 'gate',
          reads: [judge.result, checks.result],
          description: 'The work was done rather than erased, nothing new broke, and the checks still pass',
        },
      );
      const report = node({ id: 'report', type: 'router' });

      return {
        graph: graph({
          name: 'issue-fix',
          description: 'Fix one approved upkeep issue and prove the work was done.',
          nodes: [clone, pick, baseline, fix, judge, checks, gate, commit, publish, report],
          edges: [
            { from: clone, to: pick },
            { from: pick, to: baseline, when: `memory.${pick.result}.has_work` },
            // No approved work is a clean outcome, not a failure.
            { from: pick, to: report, when: `not memory.${pick.result}.has_work` },
            { from: baseline, to: fix, when: `memory.${baseline.result}.has_target` },
            // A finding already gone means the issue outlived its cause.
            { from: baseline, to: report, when: `not memory.${baseline.result}.has_target` },
            { from: fix, to: judge },
            { from: judge, to: checks },
            { from: checks, to: gate },
            { from: gate, to: commit, when: 'memory.gate_verification_passed' },
            { from: gate, to: fix, when: 'not memory.gate_verification_passed' },
            { from: commit, to: publish },
            { from: publish, to: report },
          ],
          startNode: clone,
          endNodes: [report],
        }),
        input: { goal: 'Resolve one approved upkeep issue.',
          ...(p.budgetTokens > 0 ? { maxTokenBudget: p.budgetTokens } : {}), maxIterations: 40 },
        runner: {},
      };
    },

    evals: (): EvalAssertion[] => [
      { type: 'status_equals', expected: 'completed' },
      { type: 'memory_contains', key: 'pick_result' },
    ],
  };
}
