/**
 * pr-review — a first-pass code review on a pull request.
 *
 * The maintenance loop delivers PRs; this workflow reads one the way a
 * colleague would before the human does: the full branch diff beside
 * the surrounding code. The reviewer has read-only hands — search and
 * read_file over a checkout of the PR branch — so it can verify what a
 * diff-only reviewer must take on faith: whether a helper already
 * exists, whether an edit matches the conventions around it, whether
 * the tests assert what they claim. Its verdict is posted as an
 * advisory PR comment; the human merge stays the gate, and nothing is
 * ever pushed.
 *
 * pr-revise is the counterpart: on a REVISE verdict against a PR that
 * carries the maintenance-managed label, the posted comment ends with
 * the @cycgraph trigger pr-revise listens for, so the finding is
 * addressed without a human relaying it. The label is the consent:
 * GitHub restricts labeling to triage+ users, bot PRs are labeled at
 * creation, and an unlabeled PR gets findings only. A push to a
 * labeled PR re-runs the review as a verification pass over the prior
 * findings, and the cycle is bounded by a rounds cap — after the third
 * review the findings post without a handoff and the PR waits for the
 * human, who can always take over sooner.
 *
 * @module maintenance/pr-review
 */

import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { agent, graph, node, reflection, tool } from '@cycgraph/orchestrator';
import type { EvalAssertion } from '@cycgraph/orchestrator';
import { commentOnPr, prFeedback } from '@cycgraph/tools/git';
import { createWorkspaceSession, readFileTool, searchTool } from '@cycgraph/tools/workspace';
import { CANDIDATE_TAG, LESSON_TAG } from './memory.js';
import { MANAGED_LABEL, STANDARDS_BRIEF, WORKFLOW_MENTION, resolveRepo, stripMentions } from './repo.js';
import type { MaintenanceEnv, MaintenanceWorkflow } from './types.js';

const exec = promisify(execFile);

const params = z.object({
  repoRoot: z.string().default('')
    .describe('Repository the pull request belongs to. Empty means the repository this runs inside'),
  pr: z.number().int().min(1)
    .describe('The pull request to review'),
  base: z.string().default('main')
    .describe('The branch the PR merges into; the review covers the diff against it'),
  comment: z.boolean().default(true)
    .describe('Post the review as a PR comment. Off prints it to the run state only'),
  revise: z.boolean().default(true)
    .describe('On a REVISE verdict against a PR carrying the maintenance-managed label, end the comment with an @cycgraph trigger so pr-revise addresses the findings. Unlabeled PRs get findings only. Needs the comment posted via a PAT — the Actions token\'s comments fire no workflows'),
  prompt: z.string().default('')
    .describe('Override the reviewer agent\'s instructions'),
  budgetTokens: z.number().int().min(0).default(400000)
    .describe('Hard token budget for the run; breach fails the run. Zero removes the cap'),
});

type Params = z.infer<typeof params>;

const DIFF_CAP = 60_000;

/** The pr-review workflow. */
export function prReview(): MaintenanceWorkflow<typeof params> {
  return {
    id: 'pr-review',
    title: 'Review a pull request against the code around it',
    covers: ['maintenance', 'review'],
    params,

    build: async (p: Params, env: MaintenanceEnv) => {
      const repoRoot = await resolveRepo(p.repoRoot);
      const session = createWorkspaceSession();
      const workspaceAt = join(tmpdir(), `cycgraph-pr-review-${randomUUID()}`);
      const token = env.publish?.token;

      const hands = {
        read: readFileTool({ root: workspaceAt, session }),
        search: searchTool({ root: workspaceAt }),
      };

      const gatherTool = tool({
        name: 'gather_pr',
        description: 'Check out the PR branch in a fresh clone and collect its diff against the base.',
        parameters: z.object({}),
        timeoutMs: 120_000,
        execute: async () => {
          const feedback = await prFeedback(repoRoot, p.pr, token !== undefined ? { token } : {});
          if (feedback === undefined) {
            return { has_work: false, detail: `cannot read PR #${p.pr} — gh unavailable or the PR does not exist` };
          }
          const head = feedback.headRefName;
          // Idempotent under node retry: a failure after the clone must
          // not leave a workspace the next attempt refuses to clone into.
          await rm(workspaceAt, { recursive: true, force: true });
          // The clone copies local branches only; both the PR head and the
          // base live on the source repository's remote (a CI checkout has
          // no local base branch at all), so each is fetched from the
          // source's remote-tracking refs.
          await exec('git', ['clone', '--quiet', '--no-hardlinks', repoRoot, workspaceAt]);
          await exec('git', ['fetch', '--quiet', 'origin',
            `+refs/remotes/origin/${head}:refs/heads/${head}`,
            `+refs/remotes/origin/${p.base}:refs/pr-review/base`], { cwd: workspaceAt });
          await exec('git', ['checkout', '--quiet', head], { cwd: workspaceAt });
          const { stdout: diff } = await exec(
            'git', ['diff', 'refs/pr-review/base...HEAD'],
            { cwd: workspaceAt, maxBuffer: 64 * 1024 * 1024 },
          );
          if (diff.trim() === '') {
            return { has_work: false, detail: `PR #${p.pr} holds no diff against ${p.base}` };
          }
          // Prior advisory reviews turn this run into a verification
          // pass: the reviewer checks each earlier finding before
          // judging what changed. Their count is the cycle's bound.
          const priorReviews = feedback.comments
            .filter((comment) => comment.body.startsWith('Advisory review by the pr-review workflow'));
          return {
            has_work: true,
            head,
            title: feedback.title,
            labels: feedback.labels,
            advisory_rounds: priorReviews.length,
            prior_findings: priorReviews.length > 0
              ? priorReviews[priorReviews.length - 1]!.body.slice(0, 6_000)
              : '',
            diff_bytes: diff.length,
            instruction: [
              `Review pull request #${p.pr} ("${feedback.title}"), branch ${head}, against ${p.base}.`,
              ...(priorReviews.length > 0
                ? [
                  'A previous advisory review requested changes and a revision has since been pushed. FIRST verify each of its numbered findings against the current tree, marking each ADDRESSED or UNRESOLVED with one line of evidence; then review anything the revision newly changed. The previous review:',
                  priorReviews[priorReviews.length - 1]!.body.slice(0, 6_000),
                ]
                : []),
              'The full diff:',
              '```diff',
              diff.length > DIFF_CAP ? `${diff.slice(0, DIFF_CAP)}\n… (truncated at ${DIFF_CAP} bytes)` : diff,
              '```',
            ].join('\n'),
          };
        },
      });

      const verdictTool = tool({
        name: 'review_verdict',
        description: 'Parse the review into a verdict and finding count.',
        parameters: z.object({ review: z.unknown().optional(), verdict_result: z.unknown().optional() }),
        execute: async ({ review, verdict_result }) => {
          const text = String(review ?? '');
          const round = ((verdict_result as { round?: number } | undefined)?.round ?? 0) + 1;
          // No marker at all is a reviewer that ran out of steps
          // mid-investigation, not a request for changes: inconclusive,
          // retried once, and never handed to pr-revise.
          const malformed = !/^\s*VERDICT:\s*(APPROVE|REVISE)/m.test(text);
          const approved = /^\s*VERDICT:\s*APPROVE/m.test(text);
          const findings = (text.match(/^\s*\d+\.\s/gm) ?? []).length;
          return {
            approved,
            malformed,
            round,
            finding_count: findings,
            detail: malformed
              ? `the review carries no VERDICT marker (round ${round}) — inconclusive`
              : approved
                ? `approved with ${findings} advisory note(s)`
                : `requested changes: ${findings} finding(s)`,
          };
        },
      });

      const deliverTool = tool({
        name: 'post_review',
        description: 'Post the review as an advisory comment on the PR.',
        parameters: z.object({
          review: z.unknown().optional(),
          verdict_result: z.unknown().optional(),
          gather_result: z.unknown().optional(),
        }),
        timeoutMs: 60_000,
        execute: async ({ review, verdict_result, gather_result }) => {
          const verdict = verdict_result as { detail?: string; approved?: boolean; malformed?: boolean } | undefined;
          const gathered = gather_result as { labels?: string[]; advisory_rounds?: number } | undefined;
          const labels = gathered?.labels ?? [];
          const rounds = gathered?.advisory_rounds ?? 0;
          if (verdict?.malformed === true) {
            return { posted: false, detail: `nothing posted — ${verdict.detail ?? 'inconclusive review'}` };
          }
          if (!p.comment) return { posted: false, detail: `comment is off — ${verdict?.detail ?? ''}` };
          // Mentions inside the review text are stripped (an echoed
          // mention would re-trigger workflows on arbitrary reviewer
          // prose); the one deliberate trigger below is the exception.
          const body = stripMentions(String(review ?? '')).slice(0, 12_000);
          // A REVISE verdict hands off to pr-revise via its comment
          // trigger — only on PRs carrying the managed label, which
          // GitHub restricts to triage+ users: bot PRs are labeled at
          // birth, a maintainer labels their own by hand, and anyone
          // else gets the findings without the bot pushing to their
          // branch unasked. Bounded: the revision reply strips mentions
          // and a branch push does not re-run this review.
          // Bounded at three reviews (two revisions) per PR: past the
          // cap, findings still post but the cycle hands back to the
          // human instead of dispatching another revision.
          const handoff = p.revise && verdict?.approved === false
            && labels.includes(MANAGED_LABEL) && rounds < 2
            ? `\n\n${WORKFLOW_MENTION} please address the numbered findings above.`
            : p.revise && verdict?.approved === false && labels.includes(MANAGED_LABEL)
              ? '\n\nRevision cycle cap reached — leaving the remaining findings to human review.'
              : '';
          const reply = await commentOnPr(repoRoot, p.pr,
            `Advisory review by the pr-review workflow — the human merge decision stands either way.\n\n${body}${handoff}`,
            token !== undefined ? { token } : {});
          return {
            posted: reply.ok,
            revision_requested: handoff !== '',
            detail: `${verdict?.detail ?? ''}${handoff !== '' ? '; revision requested' : ''}; ${reply.detail}`,
          };
        },
      });

      const reviewer = agent({
        id: 'pr-reviewer',
        name: 'PR reviewer',
        model: env.model,
        provider: env.provider,
        temperature: 0.2,
        maxSteps: 24,
        instructions: p.prompt !== '' ? p.prompt : [
          'You review one pull request the way a careful colleague would: the diff is in your instructions, and the whole repository at that PR\'s branch is under your read-only hands.',
          'Verify before you claim. Use search and read_file to check what the diff alone cannot show: whether a new helper duplicates something that already exists, whether the edit matches the conventions of the code around it, whether tests assert real behavior, whether names and structures fit where they were placed.',
          STANDARDS_BRIEF,
          'Report only findings you have verified against the tree, each with the file and what to change. Do not nitpick working code a reasonable reviewer would pass, and say what is good in one line when it is.',
          'Budget your steps: the reply is the only thing that leaves this run, and a review that never reaches its VERDICT is worthless. Once roughly three quarters of your steps are spent, stop investigating and write the verdict from what you have confirmed.',
          'Structure your reply exactly as:',
          'VERDICT: APPROVE or VERDICT: REVISE',
          'then a one-line summary, then numbered findings (if any), each as: <file> — <the problem> — <what to do instead>.',
        ].join(' '),
        tools: [hands.search, hands.read],
      });

      // Cross-run learning tail — see docs-workflow for the pattern.
      const distiller = agent({
        id: 'pr-review-lesson-distiller',
        name: 'Review lesson distiller',
        model: env.model,
        provider: env.provider,
        temperature: 0.2,
        maxSteps: 1,
        instructions: [
          'You distill one pull-request review into transferable lessons for the agents that write and review future maintenance PRs.',
          'A lesson is one present-tense sentence about a recurring defect class or convention miss that would change how the NEXT change is written or reviewed.',
          'Never include run-specific details (PR numbers, branch names, file paths). Return no facts when nothing transferable appeared.',
        ].join(' '),
      });
      const reflect = env.memory
        ? reflection(['review'], {
            id: 'reflect',
            reads: ['review'],
            failurePolicy: { maxRetries: 2 },
            extractor: { type: 'llm', agentId: distiller, maxFacts: 2 },
            tags: [LESSON_TAG, 'wf:pr-review', CANDIDATE_TAG],
          })
        : undefined;

      const gather = node({ id: 'gather', type: 'tool', toolId: 'gather_pr', tools: [gatherTool], reads: [] });
      const review = node({
        id: 'review',
        agent: reviewer,
        failurePolicy: { timeoutMs: 1_200_000 },
        reads: [gather.result],
        writes: 'review',
        ...(env.memory ? { memoryQuery: { tags: ['wf:pr-review'], maxFacts: 6 } } : {}),
      });
      const verdict = node({ id: 'verdict', type: 'tool', toolId: 'review_verdict', tools: [verdictTool], reads: ['review', 'verdict_result'] });
      const deliver = node({
        id: 'deliver',
        type: 'tool',
        toolId: 'post_review',
        tools: [deliverTool],
        reads: ['review', verdict.result, gather.result],
      });
      const report = node({ id: 'report', type: 'router' });

      return {
        graph: graph({
          name: 'pr-review',
          description: 'Read a PR beside its codebase and post an advisory review.',
          nodes: [gather, review, verdict, deliver, ...(reflect ? [reflect] : []), report],
          edges: [
            { from: gather, to: review, when: `memory.${gather.result}.has_work` },
            { from: gather, to: report, when: `not memory.${gather.result}.has_work` },
            { from: review, to: verdict },
            // An inconclusive review gets one fresh attempt; a second
            // failure flows to deliver, which posts nothing for it.
            { from: verdict, to: review, when: `memory.${verdict.result}.malformed and memory.${verdict.result}.round < 2` },
            { from: verdict, to: deliver, when: `not memory.${verdict.result}.malformed or memory.${verdict.result}.round >= 2` },
            ...(reflect
              ? [{ from: deliver, to: reflect }, { from: reflect, to: report }]
              : [{ from: deliver, to: report }]),
          ],
          startNode: gather,
          endNodes: [report],
        }),
        input: {
          goal: `Review pull request #${p.pr}.`,
          maxIterations: 12,
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
