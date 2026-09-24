/**
 * push_revision — commit, push, and reply.
 *
 * The delivery step: it commits the revision, pushes the PR branch in
 * place, answers each review thread inside it, posts a timeline summary
 * that also answers the top-level feedback, and clears any needs-human label a prior failed run
 * left behind. With push off it returns the diff for inspection and
 * touches nothing. It never opens or merges — the PR still ends at the
 * human verdict.
 *
 * @module maintenance/pr-revise/tools/push-revision
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
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
import { parseReplies, reviewMarker, withoutReplies } from '../../shared/review-findings.js';
import type { Provenance } from '../../shared/review-findings.js';
import { modelFor } from '../../shared/models.js';
import { dryRunPreview, provenanceFooter } from '../../shared/provenance.js';
import { REVISION_PREFIX } from '../../shared/review-threads.js';
import { stripMentions } from '../../shared/repo.js';
import type { ReviseContext } from '../context.js';

const exec = promisify(execFile);

/** A review thread's label and the comment its replies thread under. */
type ReplyTarget = { label: string; id: number };

/** A top-level feedback item's label and the excerpt its reply quotes. */
type TopLevelItem = { label: string; excerpt: string };

/** A reply the reviser owes inside one review thread. */
type ThreadReply = { label: string; id: number; body: string };

/** The thread replies the report carries, one per answered thread. */
function threadReplies(
  replies: ReadonlyMap<string, string>,
  targets: readonly ReplyTarget[],
  provenance: Provenance,
): ThreadReply[] {
  return targets.flatMap((target) => {
    const text = replies.get(target.label);
    return text !== undefined
      ? [{ label: target.label, id: target.id, body: `${reviewMarker('reply', provenance)}\n${text.slice(0, 2_000)}` }]
      : [];
  });
}

/**
 * Post each reply inside its thread, and return how many landed. A reply
 * whose post fails is skipped.
 */
async function postThreadedReplies(
  repoRoot: string,
  pr: number,
  planned: readonly ThreadReply[],
  auth: { token?: string },
): Promise<number> {
  let threaded = 0;
  for (const reply of planned) {
    if ((await replyToReviewComment(repoRoot, pr, reply.id, reply.body, auth)).ok) threaded += 1;
  }
  return threaded;
}

/**
 * The summary comment: what changed, then one answer per top-level item,
 * each beside the excerpt it answers, since a review body or conversation
 * comment has no thread to reply in.
 */
export function revisionSummary(
  report: string,
  replies: ReadonlyMap<string, string>,
  items: readonly TopLevelItem[],
  filesChanged: readonly string[],
  stamp: { provenance?: Provenance; footer?: string } = {},
): string {
  // An empty or absent summary still gets a concrete comment: the
  // changed files are the floor the model cannot undercut.
  const summary = withoutReplies(report).slice(0, 1_500)
    || `Revised ${filesChanged.length} file(s): ${filesChanged.slice(0, 15).join(', ')}.`;
  const answers = items.flatMap((item) => {
    const text = replies.get(item.label);
    return text !== undefined ? [`- **Re: ${item.excerpt}** ${text.slice(0, 1_000)}`] : [];
  });
  return [
    reviewMarker('revision', stamp.provenance),
    REVISION_PREFIX,
    '',
    summary,
    ...(answers.length > 0 ? ['', ...answers] : []),
    ...(stamp.footer ? ['', stamp.footer] : []),
  ].join('\n');
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
      const gathered = gather_result as {
        head?: string;
        reply_targets?: ReplyTarget[];
        top_level_items?: TopLevelItem[];
      } | undefined;
      const head = gathered?.head ?? '';

      // 1. Nothing to deliver. Every reply posts through the same PAT that
      // triggers the workflow, so a mention echoed from the report is
      // stripped or it would re-dispatch this workflow.
      const filesChanged = await changedIn(workspaceAt);
      if (filesChanged.length === 0) {
        return { pushed: false, detail: 'nothing was changed' };
      }
      const diff = await pendingDiff(workspaceAt);
      const report = stripMentions(String(revise_report ?? ''));
      const replies = parseReplies(report);
      const model = modelFor(env, 'high');

      // The replies and the summary, stamped with the commit they answer
      // from: the pushed revision, or none yet in a dry run.
      const planFor = (commit: string | undefined) => {
        const provenance: Provenance = {
          ...(env.provenance !== undefined ? { run: env.provenance.runId } : {}),
          ...(commit !== undefined ? { commit } : {}),
          model,
        };
        const footer = provenanceFooter('Revised in', {
          ...(commit !== undefined ? { commit } : {}),
          model,
          ...(env.provenance?.runUrl !== undefined ? { runUrl: env.provenance.runUrl } : {}),
        });
        return {
          threaded: threadReplies(replies, gathered?.reply_targets ?? [], provenance),
          summary: revisionSummary(report, replies, gathered?.top_level_items ?? [], filesChanged, { provenance, footer }),
        };
      };

      // 2. A dry run stops here: the edits stay in the workspace, and the
      // result carries everything the run would have posted.
      if (!p.push) {
        const plan = planFor(undefined);
        return {
          pushed: false,
          detail: `push is off; workspace left for inspection at ${workspaceAt}`,
          diff,
          preview: dryRunPreview([
            { title: 'workspace', body: workspaceAt },
            { title: `diff (${filesChanged.length} file(s))`, body: diff.length > 8_000 ? `${diff.slice(0, 8_000)}\n… (truncated)` : diff },
            ...plan.threaded.map((reply) => ({ title: `reply in ${reply.label}`, body: reply.body })),
            { title: 'conversation comment', body: plan.summary },
          ]),
        };
      }

      // 3. Commit and push the revision to the PR branch.
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

      // 4. Reply — after the push, so no thread claims work that never
      // landed: a threaded reply beside each thread item, then one
      // timeline comment carrying the summary and the top-level answers.
      const commit = await exec('git', ['rev-parse', 'HEAD'], { cwd: workspaceAt })
        .then(({ stdout }) => stdout.trim() || undefined)
        .catch(() => undefined);
      const plan = planFor(commit);
      const threaded = await postThreadedReplies(repoRoot, p.pr, plan.threaded, auth);
      // A delivered revision resolves any waiting-on-human state a prior
      // failed run left behind; removing an absent label is a no-op.
      await setPrLabels(repoRoot, p.pr, { remove: [ctx.labels.needsHuman] }, auth);
      const reply = await commentOnPr(repoRoot, p.pr, plan.summary, auth);

      // 5. Report what landed.
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
