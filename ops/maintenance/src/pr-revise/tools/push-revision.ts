/**
 * push_revision — commit, push, and reply.
 *
 * The delivery step: it commits the revision, pushes the PR branch in
 * place, answers each diff-anchored finding in its own thread, posts a
 * timeline summary, and clears any needs-human label a prior failed run
 * left behind. With push off it returns the diff for inspection and
 * touches nothing. It never opens or merges — the PR still ends at the
 * human verdict.
 *
 * @module maintenance/pr-revise/tools/push-revision
 */

import { z } from 'zod';
import { tool } from '@cycgraph/orchestrator';
import {
  changedIn,
  commentOnPr,
  commit as commitBranch,
  pendingDiff,
  pushBranch,
  replyToReviewComment,
  setPrLabels,
} from '@cycgraph/tools/git';
import { parseNumberedReplies } from '../../shared/review-findings.js';
import { stripMentions } from '../../shared/repo.js';
import type { ReviseContext } from '../context.js';

/** A diff-anchored feedback item and the thread it lives in. */
type ReplyTarget = { index: number; id: number };

/**
 * Reply to each diff-anchored finding in its own thread, and return how
 * many landed. The reviser's numbered REPLY lines are matched to the
 * feedback items that carry a thread id; an item with no matching reply is
 * skipped, as is a reply whose post fails.
 */
async function postThreadedReplies(
  repoRoot: string,
  pr: number,
  report: string,
  targets: readonly ReplyTarget[],
  auth: { token?: string },
): Promise<number> {
  const replies = parseNumberedReplies(report);
  let threaded = 0;
  for (const target of targets) {
    const text = replies.get(target.index);
    if (text === undefined) continue;
    const posted = await replyToReviewComment(repoRoot, pr, target.id, text.slice(0, 2_000), auth);
    if (posted.ok) threaded += 1;
  }
  return threaded;
}

/** The commit-push-reply delivery tool, bound to the clone. */
export function pushRevisionTool(c: ReviseContext) {
  const { workspaceAt, repoRoot, token, env, params: p, maintenance: ctx } = c;
  const auth = token !== undefined ? { token } : {};
  return tool({
    name: 'push_revision',
    description: 'Commit the revision, push the PR branch, and reply on the PR.',
    parameters: z.object({
      gather_result: z.unknown().optional(),
      revise_report: z.unknown().optional()
    }),
    timeoutMs: 120_000,
    execute: async ({ gather_result, revise_report }) => {
      const gathered = gather_result as { head?: string; reply_targets?: ReplyTarget[] } | undefined;
      const head = gathered?.head ?? '';

      // 1. Nothing to deliver, or delivery is off.
      const filesChanged = await changedIn(workspaceAt);
      if (filesChanged.length === 0) {
        return { pushed: false, detail: 'nothing was changed' };
      }
      const diff = await pendingDiff(workspaceAt);
      if (!p.push) {
        return { pushed: false, detail: 'push is off; workspace left for inspection', diff };
      }

      // 2. Commit and push the revision to the PR branch. Every reply posts
      // through the same PAT that triggers the workflow, so a mention echoed
      // from the report is stripped or it would re-dispatch this workflow.
      const report = stripMentions(String(revise_report ?? ''));
      await commitBranch(
        workspaceAt,
        `revise: address review feedback on #${p.pr}\n\n${report.slice(0, 1_500)}`.trim(),
        env.publish?.identity,
      );
      try {
        await pushBranch({ root: workspaceAt, branch: head }, repoRoot);
      } catch (error) {
        return { pushed: false, detail: `push failed: ${(error as Error).message.split('\n')[0] ?? ''}`, diff };
      }

      // 3. Reply — after the push, so no thread claims work that never
      // landed: a threaded reply beside each finding, then one timeline
      // comment with the summary minus the REPLY lines the threads carry.
      const threaded = await postThreadedReplies(repoRoot, p.pr, report, gathered?.reply_targets ?? [], auth);
      // An empty or absent summary still gets a concrete comment: the
      // changed files are the floor the model cannot undercut.
      const summary = report.replace(/^\s*REPLY\s+\d+\s*:.*$/gim, '').trim().slice(0, 1_500)
        || `Revised ${filesChanged.length} file(s): ${filesChanged.slice(0, 15).join(', ')}.`;
      // A delivered revision resolves any waiting-on-human state a prior
      // failed run left behind; removing an absent label is a no-op.
      await setPrLabels(repoRoot, p.pr, { remove: [ctx.labels.needsHuman] }, auth);
      const reply = await commentOnPr(repoRoot, p.pr,
        `Addressed the review feedback in the latest commit.\n\n${summary}`, auth);

      // 4. Report what landed.
      return {
        pushed: true,
        branch: head,
        replied: reply.ok,
        threaded_replies: threaded,
        detail: `pushed revision to ${head}; ${threaded} threaded repl${threaded === 1 ? 'y' : 'ies'}; ${reply.detail}`,
        diff,
      };
    },
  });
}
