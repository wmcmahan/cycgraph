/**
 * pr-revise — human review feedback, closed as a loop.
 *
 * The PR is the durable state: a reviewer requesting changes or
 * commenting on a maintenance pull request dispatches this run, which
 * reads the feedback, revises the same branch in a fresh clone, and
 * pushes — updating the PR in place — then replies with what it did.
 * This is the CI-shaped form of human-in-the-loop: no paused run waits
 * for the human; the human's event starts the next run.
 *
 * The reviser gets the full editing surface plus run_check, the same
 * tree-mutation discipline as feat-implement's acceptance, and the
 * repository's checks as its gate. It never opens or merges anything:
 * the PR it updates still ends at the human verdict.
 *
 * @module maintenance/pr-revise
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
  changedIn,
  commentOnPr,
  commit as commitBranch,
  pendingDiff,
  prFeedback,
  pushBranch,
} from '@cycgraph/tools/git';
import {
  createFileTool,
  createWorkspaceSession,
  editFileTool,
  readFileTool,
  searchTool,
} from '@cycgraph/tools/workspace';
import { safeAcceptanceCommand } from './proposal.js';
import { resolveRepo } from './repo.js';
import type { MaintenanceEnv, MaintenanceWorkflow } from './types.js';

const exec = promisify(execFile);

const params = z.object({
  repoRoot: z.string().default('')
    .describe('Repository the pull request belongs to. Empty means the repository this runs inside'),
  pr: z.number().int().min(1)
    .describe('The pull request whose review feedback is addressed'),
  checks: z.array(z.string()).default([])
    .describe('Commands that must pass before the revision is pushed, e.g. ["npm run lint:eslint"]'),
  attempts: z.number().int().min(1).max(4).default(2)
    .describe('Revision attempts before the run gives up'),
  push: z.boolean().default(true)
    .describe('Push the revision to the PR branch and reply. Off leaves the workspace for inspection'),
  prompt: z.string().default('')
    .describe('Override the reviser agent\'s instructions'),
  budgetTokens: z.number().int().min(0).default(400000)
    .describe('Hard token budget for the run; breach fails the run. Zero removes the cap'),
});

type Params = z.infer<typeof params>;

/** The pr-revise workflow. */
export function prRevise(): MaintenanceWorkflow<typeof params> {
  return {
    id: 'pr-revise',
    title: 'Address human review feedback on a maintenance PR',
    covers: ['maintenance', 'review', 'workspace'],
    params,

    build: async (p: Params, env: MaintenanceEnv) => {
      const repoRoot = await resolveRepo(p.repoRoot);
      const session = createWorkspaceSession();
      const workspaceAt = join(tmpdir(), `cycgraph-pr-revise-${randomUUID()}`);
      const token = env.publish?.token;

      const hands = {
        read: readFileTool({ root: workspaceAt, session }),
        search: searchTool({ root: workspaceAt }),
        edit: editFileTool({ root: workspaceAt, session }),
        create: createFileTool({ root: workspaceAt, session }),
      };

      const runCheckTool = tool({
        name: 'run_check',
        description: 'Run one repository check command (npm test, npm run <script> [--workspace=pkg], npx vitest run [path], npx tsc --noEmit) in the workspace and see its output.',
        parameters: z.object({ command: z.string().describe('The exact command to run; must match an allowed repository check shape') }),
        timeoutMs: 960_000,
        execute: async ({ command }) => {
          const safe = safeAcceptanceCommand(command);
          if (safe === undefined) {
            return { passed: false, output: `refused: '${command}' is not an allowed repository check shape` };
          }
          try {
            const { stdout } = await exec('sh', ['-c', safe], { cwd: workspaceAt, maxBuffer: 64 * 1024 * 1024, timeout: 900_000 });
            return { passed: true, output: String(stdout).slice(-1_500) };
          } catch (error) {
            return {
              passed: false,
              output: String((error as { stdout?: string; stderr?: string }).stdout
                ?? (error as { stderr?: string }).stderr ?? (error as Error).message).slice(-3_000),
            };
          }
        },
      });

      const gatherTool = tool({
        name: 'gather_feedback',
        description: 'Read the PR\'s review feedback and check out its branch in a fresh clone.',
        parameters: z.object({}),
        timeoutMs: 120_000,
        execute: async () => {
          const feedback = await prFeedback(repoRoot, p.pr, token !== undefined ? { token } : {});
          if (feedback === undefined) {
            return { has_work: false, detail: `cannot read PR #${p.pr} — gh unavailable or the PR does not exist` };
          }
          if (feedback.comments.length === 0) {
            return { has_work: false, detail: `PR #${p.pr} carries no review feedback to address` };
          }
          const head = feedback.headRefName;
          // The clone copies local branches only; the PR head lives on the
          // source repository's remote, so it is fetched from the source's
          // remote-tracking ref into a local branch, then checked out.
          await exec('git', ['clone', '--quiet', '--no-hardlinks', repoRoot, workspaceAt]);
          await exec('git', ['fetch', '--quiet', 'origin', `+refs/remotes/origin/${head}:refs/heads/${head}`], { cwd: workspaceAt });
          await exec('git', ['checkout', '--quiet', head], { cwd: workspaceAt });
          const { existsSync } = await import('node:fs');
          const { symlink } = await import('node:fs/promises');
          if (existsSync(join(repoRoot, 'node_modules')) && !existsSync(join(workspaceAt, 'node_modules'))) {
            await symlink(join(repoRoot, 'node_modules'), join(workspaceAt, 'node_modules'));
            await exec('sh', ['-c', `echo node_modules >> ${join(workspaceAt, '.git', 'info', 'exclude')}`]);
          }
          return {
            has_work: true,
            head,
            title: feedback.title,
            comment_count: feedback.comments.length,
            instruction: [
              `Address the human review feedback on pull request #${p.pr} ("${feedback.title}").`,
              'The feedback, verbatim:',
              ...feedback.comments.map((comment: { author: string; body: string; path?: string; line?: number }, index: number) =>
                `${index + 1}. [${comment.author}${comment.path !== undefined ? ` on ${comment.path}${comment.line !== undefined ? `:${comment.line}` : ''}` : ''}] ${comment.body}`),
            ].join('\n'),
          };
        },
      });

      const checksTool = tool({
        name: 'repo_checks',
        description: 'Run the repository\'s own checks in the workspace, refusing tree mutation.',
        parameters: z.object({}),
        timeoutMs: 1_200_000,
        execute: async () => {
          const treeBefore = (await changedIn(workspaceAt)).join('\n');
          if (p.checks.length > 0) {
            try {
              await exec('sh', ['-c', p.checks.join(' && ')], { cwd: workspaceAt, maxBuffer: 64 * 1024 * 1024 });
            } catch (error) {
              return { clean: false, output: String((error as { stdout?: string }).stdout ?? (error as Error).message).slice(-2_000) };
            }
          }
          const mutated = (await changedIn(workspaceAt)).join('\n') !== treeBefore;
          return mutated
            ? { clean: false, output: 'running the checks modified the tree — tests must not write source files' }
            : { clean: true, output: 'checks passed' };
        },
      });

      const deliverTool = tool({
        name: 'push_revision',
        description: 'Commit the revision, push the PR branch, and reply on the PR.',
        parameters: z.object({ gather_result: z.unknown().optional(), revise_report: z.unknown().optional() }),
        timeoutMs: 120_000,
        execute: async ({ gather_result, revise_report }) => {
          const head = (gather_result as { head?: string } | undefined)?.head ?? '';
          const changed = await changedIn(workspaceAt);
          if (changed.length === 0) return { pushed: false, detail: 'nothing was changed' };
          const diff = await pendingDiff(workspaceAt);
          if (!p.push) return { pushed: false, detail: 'push is off; workspace left for inspection', diff };

          await commitBranch(workspaceAt, `revise: address review feedback on #${p.pr}`, env.publish?.identity);
          try {
            await pushBranch({ root: workspaceAt, branch: head }, repoRoot);
          } catch (error) {
            return { pushed: false, detail: `push failed: ${(error as Error).message.split('\n')[0] ?? ''}`, diff };
          }
          // The reply posts through the same PAT that triggers the
          // workflow, so an echoed mention would re-dispatch it on its
          // own comment.
          const summary = String(revise_report ?? '').replace(/@cycgraph/gi, 'cycgraph').slice(0, 1_500);
          const reply = await commentOnPr(repoRoot, p.pr,
            `Addressed the review feedback in the latest commit.\n\n${summary}`,
            token !== undefined ? { token } : {});
          return { pushed: true, branch: head, replied: reply.ok, detail: `pushed revision to ${head}; ${reply.detail}`, diff };
        },
      });

      const reviser = agent({
        id: 'pr-reviser',
        name: 'PR reviser',
        model: env.model,
        provider: env.provider,
        temperature: 0.2,
        maxSteps: 32,
        instructions: p.prompt !== '' ? p.prompt : [
          'You address human review feedback on a pull request; the feedback in your context is the instruction, and the reviewer is right until proven otherwise.',
          'The workspace is already on the PR branch. Fix exactly what the feedback names — nothing else.',
          'Use search to orient, read_file for exact bytes (window large files), edit_file and create_file to change things, and run_check to verify with the repository\'s own commands before replying.',
          'A multi-match edit refusal means retry with a longer find, never a different path.',
          'When done, reply with a short summary of what you changed per comment, so it can be posted back to the reviewer.',
        ].join(' '),
        tools: [hands.search, hands.read, hands.edit, hands.create, runCheckTool],
      });

      const gather = node({ id: 'gather', type: 'tool', toolId: 'gather_feedback', tools: [gatherTool], reads: [] });
      const revise = node({
        id: 'revise',
        agent: reviser,
        failurePolicy: { timeoutMs: 1_200_000 },
        reads: [gather.result, 'checks_result'],
        writes: 'revise_report',
      });
      const checks = node({ id: 'checks', type: 'tool', toolId: 'repo_checks', tools: [checksTool], reads: [] });
      const gate = verifier.expression(
        `memory.${checks.result}.clean`,
        {
          id: 'gate',
          reads: [checks.result],
          description: 'The repository\'s checks pass and nothing mutated the tree',
        },
      );
      const deliver = node({
        id: 'deliver',
        type: 'tool',
        toolId: 'push_revision',
        tools: [deliverTool],
        reads: [gather.result, 'revise_report'],
      });
      const report = node({ id: 'report', type: 'router' });

      return {
        graph: graph({
          name: 'pr-revise',
          description: 'Turn human review feedback into a revision commit on the same PR.',
          nodes: [gather, revise, checks, gate, deliver, report],
          edges: [
            { from: gather, to: revise, when: `memory.${gather.result}.has_work` },
            { from: gather, to: report, when: `not memory.${gather.result}.has_work` },
            { from: revise, to: checks },
            { from: checks, to: gate },
            { from: gate, to: deliver, when: 'memory.gate_verification_passed' },
            { from: gate, to: revise, when: 'not memory.gate_verification_passed' },
            { from: deliver, to: report },
          ],
          startNode: gather,
          endNodes: [report],
        }),
        input: {
          goal: `Address review feedback on PR #${p.pr}.`,
          maxIterations: 4 + p.attempts * 3,
          ...(p.budgetTokens > 0 ? { maxTokenBudget: p.budgetTokens } : {}),
        },
        runner: {},
      };
    },

    evals: (): EvalAssertion[] => [
      { type: 'status_equals', expected: 'completed' },
      { type: 'memory_contains', key: 'gather_result' },
    ],
  };
}
