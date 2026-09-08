/**
 * feat-implement — implement one approved feature ticket.
 *
 * The ambitious rung of the proposal ladder. The ticket is the spec: an
 * agent implements against its motivation, design sketch, and evidence,
 * and the judge is the ticket's own acceptance criteria — every
 * criterion shaped like a safe repository command is executed and must
 * pass; the rest are listed in the PR for the human review, which was
 * always the feature tier's real gate. A gate failure feeds the failing
 * output back to the agent, bounded by attempts.
 *
 * Only command shapes from the allowlist ever run
 * (`safeAcceptanceCommand`): an issue body is semi-trusted, so runnable
 * criteria may invoke the repository's own scripts and checkers, never
 * arbitrary programs. `--ticketFile` runs detached from GitHub.
 *
 * @module maintenance/feat-implement
 */

import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { agent, graph, node, tool, verifier } from '@cycgraph/orchestrator';
import type { EvalAssertion } from '@cycgraph/orchestrator';
import { changedIn, deliveryNodes, issueMarkers, listOpenIssues, pendingDiff } from '@cycgraph/tools/git';
import {
  createFileTool,
  createWorkspaceSession,
  editFileTool,
  readFileTool,
  searchTool,
} from '@cycgraph/tools/workspace';
import { parseProposal, safeAcceptanceCommand } from './proposal.js';
import { resolveRepo } from './repo.js';
import type { MaintenanceEnv, MaintenanceWorkflow } from './types.js';

const exec = promisify(execFile);

const params = z.object({
  repoRoot: z.string().default('')
    .describe('Repository the feature lands in. Empty means the repository this runs inside'),
  label: z.string().default('maintenance-approved')
    .describe('Only tickets carrying this label are picked up — the human approval gate'),
  issueNumber: z.number().int().min(0).default(0)
    .describe('Implement this specific ticket. Zero picks the oldest approved one'),
  ticketFile: z.string().default('')
    .describe('Detached mode: read the ticket body from this file instead of GitHub; closes nothing'),
  attempts: z.number().int().min(1).max(6).default(3)
    .describe('Implementation attempts before the run gives up; each re-runs the acceptance criteria'),
  checks: z.array(z.string()).default([])
    .describe('Commands that must pass beyond the acceptance criteria, e.g. ["npm run lint"]'),
  commit: z.boolean().default(true)
    .describe('Commit the accepted implementation. Off leaves the workspace for inspection'),
  publish: z.boolean().default(true)
    .describe('Push and open the PR. Off leaves the prepared publish script'),
  prompt: z.string().default('')
    .describe('Override the implementer agent\'s instructions'),
  budgetTokens: z.number().int().min(0).default(900000)
    .describe('Hard token budget for the run; breach fails the run. Zero removes the cap'),
});

type Params = z.infer<typeof params>;

/** The feat-implement workflow. */
export function featImplement(): MaintenanceWorkflow<typeof params> {
  return {
    id: 'feat-implement',
    title: 'Implement one approved feature ticket',
    covers: ['maintenance', 'feature', 'workspace'],
    params,

    build: async (p: Params, env: MaintenanceEnv) => {
      const repoRoot = await resolveRepo(p.repoRoot);
      const session = createWorkspaceSession();
      const workspaceAt = join(tmpdir(), `cycgraph-feat-impl-${randomUUID()}`);
      const token = env.publish?.token;

      const hands = {
        read: readFileTool({ root: workspaceAt, session }),
        search: searchTool({ root: workspaceAt }),
        edit: editFileTool({ root: workspaceAt, session }),
        create: createFileTool({ root: workspaceAt, session }),
      };

      // The implementer can run repository checks itself, so it iterates
      // test-driven inside its turn instead of editing blind and waiting
      // for the acceptance node's verdict. Same allowlist as acceptance:
      // repository script shapes only, never arbitrary programs.
      const runCheckTool = tool({
        name: 'run_check',
        description: 'Run one repository check command (npm test, npm run <script> [--workspace=pkg], npx vitest run [path], npx tsc --noEmit) in the workspace and see its output.',
        parameters: z.object({ command: z.string().describe('The exact command to run; must match an allowed repository script shape') }),
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

      const delivery = deliveryNodes({
        repoRoot,
        workspaceAt,
        branch: `feat/impl-${randomUUID().slice(0, 8)}`,
        title: 'feat: implement an approved proposal',
        detailFrom: 'accept_result',
        evidence: (details: string[]) => ({
          summary: `An approved feature ticket, implemented by the feat-implement workflow. ${details.join(' ')}`.trim(),
          ...(details.length > 0 ? { changes: details } : {}),
          provenance: 'feat-implement: the ticket is the spec; every runnable acceptance criterion passed in the clone, and the criteria needing judgement are listed for this review.',
        }),
        commit: p.commit,
        publish: p.publish,
        ...(env.publish !== undefined ? { config: env.publish } : {}),
      });

      const pickTool = tool({
        name: 'pick_ticket',
        description: 'Pick the oldest approved feature ticket and parse its proposal.',
        parameters: z.object({}),
        timeoutMs: 60_000,
        execute: async () => {
          const parse = (body: string, issueNumber?: number): Record<string, unknown> => {
            const proposal = parseProposal(body);
            if (proposal.missing.length > 0) {
              return { has_work: false, detail: `the ticket is missing ${proposal.missing.join(', ')} — not implementable as written` };
            }
            const runnable = proposal.acceptance
              .flatMap((bullet) => { const c = safeAcceptanceCommand(bullet); return c !== undefined ? [c] : []; });
            const manual = proposal.acceptance
              .filter((bullet) => safeAcceptanceCommand(bullet) === undefined);
            return {
              has_work: true,
              ...(issueNumber !== undefined ? { issue_number: issueNumber } : { detached: true }),
              title: proposal.title,
              runnable,
              manual,
              instruction: [
                `Implement this approved feature: ${proposal.title}`,
                `MOTIVATION:\n${proposal.motivation}`,
                `DESIGN:\n${proposal.design}`,
                `EVIDENCE:\n${proposal.evidence}`,
                `ACCEPTANCE (the runnable ones will be executed exactly as written):\n${proposal.acceptance.map((a) => `- ${a}`).join('\n')}`,
              ].join('\n\n'),
            };
          };

          if (p.ticketFile !== '') return parse(await readFile(p.ticketFile, 'utf8'));
          const issues = await listOpenIssues(repoRoot, {
            label: p.label,
            ...(token !== undefined ? { token } : {}),
          });
          if (issues === undefined) {
            return { has_work: false, detail: 'cannot read the issue ledger and no --ticketFile was given' };
          }
          const picked = issues
            .filter((issue) => p.issueNumber === 0 || issue.number === p.issueNumber)
            .filter((issue) => [...issueMarkers([issue])].some((key) => key.startsWith('feature:')))
            .sort((a, b) => a.number - b.number)[0];
          if (picked === undefined) return { has_work: false, detail: `no open '${p.label}' feature ticket` };
          return parse(picked.body, picked.number);
        },
      });

      const acceptTool = tool({
        name: 'run_acceptance',
        description: 'Run the ticket\'s runnable acceptance criteria in the workspace.',
        parameters: z.object({ pick_result: z.unknown().optional() }),
        timeoutMs: 1_800_000,
        execute: async ({ pick_result }) => {
          const pick = pick_result as
            { issue_number?: number; runnable?: string[]; manual?: string[] } | undefined;
          const changed = await changedIn(workspaceAt);
          // Snapshot before running: acceptance executes agent-authored
          // code, and a test that writes source files is using the judge
          // as a write hand — the create_file bootstrap incident. Any
          // mutation of the tree during acceptance is refused as gaming,
          // exactly like a deletion satisfying a detector.
          const treeBefore = changed.join('\n');
          const failed: { command: string; output: string }[] = [];
          for (const command of pick?.runnable ?? []) {
            try {
              await exec('sh', ['-c', command], { cwd: workspaceAt, maxBuffer: 64 * 1024 * 1024, timeout: 900_000 });
            } catch (error) {
              failed.push({
                command,
                output: String((error as { stdout?: string; stderr?: string }).stdout
                  ?? (error as { stderr?: string }).stderr ?? (error as Error).message).slice(-2_000),
              });
            }
          }
          const treeAfter = (await changedIn(workspaceAt)).join('\n');
          const mutated = treeAfter !== treeBefore;
          const passed = failed.length === 0 && changed.length > 0 && !mutated;
          const closes = pick?.issue_number !== undefined ? `Closes #${pick.issue_number}. ` : '';
          return {
            passed,
            changed_count: changed.length,
            mutated_by_tests: mutated,
            failed,
            manual: pick?.manual ?? [],
            detail: changed.length === 0
              ? `${closes}nothing was changed`
              : mutated
                ? `${closes}running the acceptance criteria itself modified the tree — tests must not write source files; make the changes with your editing tools instead`
                : failed.length > 0
                  ? `${closes}acceptance failed: ${failed.map((f) => f.command).join('; ')}`
                  : `${closes}all ${pick?.runnable?.length ?? 0} runnable acceptance criteria passed; ${pick?.manual?.length ?? 0} left for review`,
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
            await exec('sh', ['-c', p.checks.join(' && ')], { cwd: workspaceAt, maxBuffer: 64 * 1024 * 1024 });
            return { clean: true, output: 'checks passed' };
          } catch (error) {
            return { clean: false, output: String((error as { stdout?: string }).stdout ?? (error as Error).message).slice(-2_000) };
          }
        },
      });

      const diffTool = tool({
        name: 'workspace_diff',
        description: 'The workspace\'s full uncommitted diff, for review.',
        parameters: z.object({}),
        execute: async () => {
          const diff = await pendingDiff(workspaceAt);
          return { diff: diff.length > 40_000 ? `${diff.slice(0, 40_000)}\n… (truncated)` : diff };
        },
      });

      const reviewCheckTool = tool({
        name: 'review_check',
        description: 'Parse the reviewer\'s verdict and count review rounds.',
        parameters: z.object({
          review: z.unknown().optional(),
          review_check_result: z.unknown().optional(),
        }),
        execute: async ({ review, review_check_result }) => {
          const text = String(review ?? '');
          const round = ((review_check_result as { round?: number } | undefined)?.round ?? 0) + 1;
          const approved = /^\s*APPROVED/m.test(text);
          return {
            approved,
            round,
            detail: approved
              ? `review approved (round ${round})`
              : `review requested revisions (round ${round}): ${text.replace(/\n/g, ' ').slice(0, 240)}`,
          };
        },
      });

      const implementer = agent({
        id: 'feature-implementer',
        name: 'Feature implementer',
        model: env.model,
        provider: env.provider,
        temperature: 0.2,
        maxSteps: 40,
        instructions: p.prompt !== '' ? p.prompt : [
          'You implement one approved feature in a codebase; the ticket in your context is the spec.',
          'Follow its design sketch and ground yourself in its evidence files. Write real code and real tests; the runnable acceptance criteria will be executed exactly as written and must pass.',
          'After editing, run the ticket\'s runnable acceptance commands yourself with run_check and iterate on the failures; only reply once they pass for you.',
          'Use search to orient, read_file for exact bytes, edit_file to change them; the find text must match exactly once, and a multi-match refusal means retry with a longer find, never a different path.',
          'read_file supports offset and limit: read windows of large files rather than whole files, and never re-read a file you have not edited since last reading.',
          'Match the surrounding code\'s style and conventions. Change nothing the feature does not need.',
          'If a previous attempt is reported with failing acceptance output, fix precisely what failed.',
          'End EVERY reply with a NOTES: section — the key files with their relevant line ranges and what you learned — so a retry can start oriented instead of re-reading; when a previous attempt\'s NOTES are in your context, trust them and only re-read files you are about to edit.',
          'When the implementation is complete, reply with: IMPLEMENTED <the ticket title>, then the NOTES: section.',
        ].join(' '),
        tools: [hands.search, hands.read, hands.edit, hands.create, runCheckTool],
      });

      // The reviewer is an advisory critic, not the verdict: the
      // mechanical gate stays the gate and the human merge stays the
      // judgment. Toolless and fed the actual diff, it exists to catch
      // what mechanical criteria cannot — a test that writes source
      // files, style violations, a design that ignores the ticket.
      const reviewer = agent({
        id: 'implementation-reviewer',
        name: 'Implementation reviewer',
        model: env.model,
        provider: env.provider,
        temperature: 0.2,
        maxSteps: 2,
        instructions: [
          'You review one implementation diff against its ticket. You have no tools; judge only what is in front of you.',
          'Refuse anything a careful human reviewer would: tests that write, delete, or mutate source files or anything outside a temp directory; eslint-disable or weakened assertions; code that ignores the ticket\'s design; missing or vacuous tests; style foreign to the surrounding codebase (comments narrating history, missing .js import extensions).',
          'Do not nitpick working code that a reasonable reviewer would pass; the goal is one round.',
          'Reply with exactly one of:',
          'APPROVED: <one line on why it is sound>',
          'REVISE:',
          '1. <specific finding with the file and what to change>',
        ].join('\n'),
        tools: [],
      });

      const { clone, commit, publish } = delivery;
      const pick = node({ id: 'pick', type: 'tool', toolId: 'pick_ticket', tools: [pickTool], reads: [] });
      // Reading its own previous report is what carries knowledge across
      // attempts: a retry starts from the prior NOTES instead of paying to
      // re-read the same files into a fresh transcript.
      const implement = node({
        id: 'implement',
        agent: implementer,
        reads: [pick.result, 'accept_result', 'implement_report', 'review'],
        writes: 'implement_report',
      });
      const accept = node({
        id: 'accept',
        type: 'tool',
        toolId: 'run_acceptance',
        tools: [acceptTool],
        reads: [pick.result],
      });
      const checks = node({ id: 'checks', type: 'tool', toolId: 'repo_checks', tools: [checksTool], reads: [] });
      const gate = verifier.expression(
        `memory.${accept.result}.passed and memory.${checks.result}.clean`,
        {
          id: 'gate',
          reads: [accept.result, checks.result],
          description: 'Something was built, every runnable acceptance criterion passed, and the checks pass',
        },
      );
      const diff = node({ id: 'diff', type: 'tool', toolId: 'workspace_diff', tools: [diffTool], reads: [] });
      const review = node({
        id: 'review',
        agent: reviewer,
        reads: [pick.result, diff.result],
        writes: 'review',
      });
      const reviewCheck = node({
        id: 'review_check',
        type: 'tool',
        toolId: 'review_check',
        tools: [reviewCheckTool],
        reads: ['review', 'review_check_result'],
      });
      const report = node({ id: 'report', type: 'router' });

      return {
        graph: graph({
          name: 'feat-implement',
          description: 'Implement an approved feature ticket against its own acceptance criteria.',
          nodes: [clone, pick, implement, accept, checks, gate, diff, review, reviewCheck, commit, publish, report],
          edges: [
            { from: clone, to: pick },
            { from: pick, to: implement, when: `memory.${pick.result}.has_work` },
            { from: pick, to: report, when: `not memory.${pick.result}.has_work` },
            { from: implement, to: accept },
            { from: accept, to: checks },
            { from: checks, to: gate },
            { from: gate, to: diff, when: 'memory.gate_verification_passed' },
            { from: diff, to: review },
            { from: review, to: reviewCheck },
            { from: reviewCheck, to: commit, when: `memory.${reviewCheck.result}.approved` },
            // Findings loop back to the implementer, bounded; a review that
            // never approves ends the run visibly rather than delivering.
            {
              from: reviewCheck,
              to: implement,
              when: `not memory.${reviewCheck.result}.approved and memory.${reviewCheck.result}.round < 3`,
            },
            {
              from: reviewCheck,
              to: report,
              when: `not memory.${reviewCheck.result}.approved and memory.${reviewCheck.result}.round >= 3`,
            },
            { from: gate, to: implement, when: 'not memory.gate_verification_passed' },
            { from: commit, to: publish },
            { from: publish, to: report },
          ],
          startNode: clone,
          endNodes: [report],
        }),
        input: {
          goal: 'Implement one approved feature ticket.',
          ...(p.budgetTokens > 0 ? { maxTokenBudget: p.budgetTokens } : {}),
          maxIterations: 10 + p.attempts * 9,
        },
        runner: {},
      };
    },

    evals: (): EvalAssertion[] => [
      { type: 'status_equals', expected: 'completed' },
      { type: 'memory_contains', key: 'pick_result' },
    ],
  };
}
