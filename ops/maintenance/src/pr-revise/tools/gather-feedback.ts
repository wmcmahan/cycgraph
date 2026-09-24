/**
 * gather_feedback — read the review, check out the branch.
 *
 * The run's first step and its gatekeeper: it reads the PR's open,
 * trusted review feedback, refuses fork PRs and unsafe branch names, clones the
 * repository fresh, checks out the PR head, links node_modules for the
 * checks, and folds any failing-CI logs into the instruction. It returns
 * `has_work: false` with a reason whenever there is nothing safe to do.
 *
 * @module maintenance/pr-revise/tools/gather-feedback
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { tool } from '@cycgraph/orchestrator';
import { isSafeGitRef, linkNestedModules, listReviewThreads, prFeedback } from '@cycgraph/tools/git';
import { fetchCiFailureLogs } from '../../shared/ci-logs.js';
import { excerptOf, renderRevisionFeedback, revisionFeedback } from '../../shared/review-threads.js';
import type { ReviseContext } from '../context.js';

const exec = promisify(execFile);

/**
 * Symlink the source repository's root node_modules into the clone when
 * the clone has none of its own, and git-ignore the link. The checks a
 * revision runs need dependencies present; a symlink avoids reinstalling.
 */
async function linkRootModules(repoRoot: string, workspaceAt: string): Promise<void> {
  if (!existsSync(join(repoRoot, 'node_modules')) || existsSync(join(workspaceAt, 'node_modules'))) return;
  await symlink(join(repoRoot, 'node_modules'), join(workspaceAt, 'node_modules'));
  await exec('sh', ['-c', `echo node_modules >> ${join(workspaceAt, '.git', 'info', 'exclude')}`]);
}

/**
 * Rebuild the workspace on the PR head, and return its commit sha.
 *
 * Idempotent under node retry: a failure after a prior clone must not
 * leave a workspace the next attempt refuses to clone into, so the old one
 * is removed first. The clone copies local branches only, so the PR head —
 * which lives on the source repository's remote — is fetched into a local
 * branch before checkout. Root and package-local module links follow, both
 * needed for the checks; `linkNestedModules` runs even when the root link
 * was skipped, and is idempotent link by link.
 */
async function checkoutPrBranch(repoRoot: string, workspaceAt: string, head: string): Promise<string> {
  await rm(workspaceAt, { recursive: true, force: true });
  await exec('git', ['clone', '--quiet', '--no-hardlinks', '--', repoRoot, workspaceAt]);
  await exec('git', ['fetch', '--quiet', 'origin', '--', `+refs/remotes/origin/${head}:refs/heads/${head}`], { cwd: workspaceAt });
  await exec('git', ['checkout', '--quiet', head], { cwd: workspaceAt });
  await linkRootModules(repoRoot, workspaceAt);
  await linkNestedModules(repoRoot, workspaceAt);
  return (await exec('git', ['rev-parse', 'HEAD'], { cwd: workspaceAt })).stdout.trim();
}

/** The feedback-reading, branch-checkout tool, bound to the clone. */
export function gatherFeedbackTool(c: ReviseContext) {
  const { workspaceAt, repoRoot, token, params: p } = c;
  const auth = token !== undefined ? { token } : {};
  return tool({
    name: 'gather_feedback',
    description: 'Read the PR\'s review feedback and check out its branch in a fresh clone.',
    parameters: z.object({}),
    timeoutMs: 120_000,
    execute: async () => {
      // 1. Read the feedback and refuse anything unsafe to act on.
      const feedback = await prFeedback(repoRoot, p.pr, auth);
      if (feedback === undefined) {
        return { has_work: false, detail: `cannot read PR #${p.pr} — gh unavailable or the PR does not exist` };
      }
      // A fork PR's head branch does not live in this repository, so
      // fetching and pushing `head` would act on a colliding base branch,
      // never the fork. The loop only revises its own branches.
      if (feedback.isCrossRepository) {
        return { has_work: false, detail: `PR #${p.pr} is from a fork; the loop only revises branches in this repository` };
      }
      // The head name is chosen by whoever pushed the branch; refuse one
      // that could become a git option or escape the fetch refspec.
      if (!isSafeGitRef(feedback.headRefName)) {
        return { has_work: false, detail: `PR #${p.pr} has an unsafe head branch name; refusing` };
      }
      // Only maintainers' text may steer an agent that pushes code, and
      // only what is still open: resolved threads and feedback an earlier
      // revision already answered are history, not instructions.
      const threads = await listReviewThreads(repoRoot, p.pr, auth);
      if (threads === undefined) {
        return { has_work: false, detail: `cannot read the review threads on PR #${p.pr}` };
      }
      const open = revisionFeedback(threads, feedback.comments);
      if (open.threads.length === 0 && open.topLevel.length === 0) {
        return { has_work: false, detail: `PR #${p.pr} carries no open review feedback to address` };
      }

      // 2. Rebuild the workspace on the PR head.
      const head = feedback.headRefName;
      const headSha = await checkoutPrBranch(repoRoot, workspaceAt, head);

      // 3. When CI failed on the head, its logs are the authority on what
      // to fix — included as data when present, absent otherwise, so a run
      // with no local checks still learns what broke.
      const ciLogs = await fetchCiFailureLogs(repoRoot, { branch: head, headSha }, auth);

      // 4. Hand the reviser the feedback and where each reply goes: a
      // thread label replies inside that thread; a top-level label has no
      // thread, so its reply rides the summary comment beside an excerpt.
      return {
        has_work: true,
        head,
        title: feedback.title,
        thread_count: open.threads.length,
        top_level_count: open.topLevel.length,
        reply_targets: open.threads.flatMap(({ label, thread }) =>
          thread.commentId !== undefined ? [{ label, id: thread.commentId }] : []),
        top_level_items: open.topLevel.map(({ label, comment }) => ({
          label,
          excerpt: excerptOf(comment.body),
        })),
        instruction: [
          `Address the review feedback on pull request #${p.pr} ("${feedback.title}").`,
          'Every item below is open feedback from a trusted maintainer or the pr-review workflow, verbatim. Items labeled T are review threads on a specific line; items labeled C are top-level feedback.',
          '',
          renderRevisionFeedback(open),
          ...(ciLogs !== undefined ? ['', ciLogs] : []),
        ].join('\n'),
      };
    },
  });
}
