/**
 * post_review — submit the review on the PR.
 *
 * Submits the verdict as a real pull-request review: findings anchor
 * inline on the diff where it can hold them, and an APPROVE approves the
 * PR (armed to auto-merge on a managed PR when `merge` is on). A REVISE on
 * a managed PR ends the body with the pr-revise trigger, bounded by a
 * rounds cap; past the cap, and on any inconclusive or failed submission,
 * the PR is labeled needs-human. A verification pass resolves the threads
 * of prior findings it marked ADDRESSED. Nothing is ever pushed.
 *
 * @module maintenance/pr-review/tools/post-review
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { tool } from '@cycgraph/orchestrator';
import { commentOnPr, commentableDiffLines, enableAutoMerge, resolveReviewThread, setPrLabels, submitPrReview } from '@cycgraph/tools/git';
import { inlineFindingMarker, parseAddressedFindings, parseReviewFindings } from '../../shared/review-findings.js';
import { WORKFLOW_MENTION, stripMentions } from '../../shared/repo.js';
import type { ReviewContext } from '../context.js';

const exec = promisify(execFile);

/** A prior finding's thread and the finding ordinal it carries. */
type ResolvableThread = { thread_id: string; ordinal: number };

/**
 * The review's findings that anchor inline: those whose file and line land
 * on a line the diff can hold a comment on. The rest stay numbered in the
 * body, which always carries all of them — the verification pass re-reads
 * the body, not threads.
 */
async function anchoredFindings(workspaceAt: string, body: string): Promise<{ path: string; line: number; body: string }[]> {
  const { stdout: diff } = await exec('git', ['diff', 'refs/pr-review/base...HEAD'],
    { cwd: workspaceAt, maxBuffer: 64 * 1024 * 1024 }).catch(() => ({ stdout: '' }));
  const anchorable = commentableDiffLines(diff);
  return parseReviewFindings(body)
    .filter((f) => f.path !== undefined && f.line !== undefined && anchorable.get(f.path)?.has(f.line) === true)
    .map((f) => ({ path: f.path!, line: f.line!, body: `${inlineFindingMarker(f.ordinal)} — ${f.text}` }));
}

/**
 * Resolve the prior-review threads whose finding this verification pass
 * marked ADDRESSED, and return how many closed. `gather` already narrowed
 * the list to that review's own threads, so human threads are never
 * touched.
 */
async function resolveAddressedThreads(
  repoRoot: string,
  body: string,
  threads: readonly ResolvableThread[],
  auth: { token?: string },
): Promise<number> {
  const addressed = new Set(parseAddressedFindings(body));
  let resolved = 0;
  for (const thread of threads) {
    if (!addressed.has(thread.ordinal)) continue;
    const outcome = await resolveReviewThread(repoRoot, thread.thread_id, auth);
    if (outcome.ok) resolved += 1;
  }
  return resolved;
}

/** The review-submitting tool, bound to the clone. */
export function postReviewTool(c: ReviewContext) {
  const { workspaceAt, repoRoot, token, params: p, maintenance: ctx } = c;
  const auth = token !== undefined ? { token } : {};
  return tool({
    name: 'post_review',
    description: 'Submit the review on the PR: verdict, body, and findings anchored inline on the diff.',
    parameters: z.object({
      review: z.unknown().optional(),
      verdict_result: z.unknown().optional(),
      gather_result: z.unknown().optional(),
    }),
    timeoutMs: 60_000,
    execute: async ({ review, verdict_result, gather_result }) => {
      const verdict = verdict_result as { detail?: string; approved?: boolean; malformed?: boolean } | undefined;
      const gathered = gather_result as {
        labels?: string[];
        advisory_rounds?: number;
        resolvable_threads?: ResolvableThread[];
      } | undefined;
      const labels = gathered?.labels ?? [];
      const rounds = gathered?.advisory_rounds ?? 0;

      // 1. Inconclusive review: label needs-human and post a plain trace
      // comment (not an advisory review — silence must never look like a
      // clean pass, and the advisory prefix is what counts rounds).
      if (verdict?.malformed === true) {
        await setPrLabels(repoRoot, p.pr, { add: [ctx.labels.needsHuman] }, auth);
        const trace = p.comment
          ? await commentOnPr(repoRoot, p.pr,
              'The automated review could not produce a verdict after two attempts (a diff-only fallback included), so this PR now carries the `needs-human` label and waits on you. '
              + 'CI checks still reflect build and test health on their own; review the diff yourself and merge or close, or re-run the PR review workflow to try again — a later successful review clears the label.',
              auth)
          : { ok: false, detail: 'comment is off' };
        return { posted: false, needs_human: true, detail: `nothing posted — ${verdict.detail ?? 'inconclusive review'}; trace: ${trace.detail}` };
      }
      if (!p.comment) return { posted: false, detail: `comment is off — ${verdict?.detail ?? ''}` };

      // 2. Build the body and the pr-revise handoff. Mentions inside the
      // review text are stripped — an echoed mention would re-trigger
      // workflows on arbitrary reviewer prose — and the one deliberate
      // trigger is the handoff below, only on a managed PR (GitHub
      // restricts that label to triage+ users) and only within the rounds
      // cap: past it, findings still post but the cycle hands to the human.
      const body = stripMentions(String(review ?? '')).slice(0, 12_000);
      const reviseEligible = p.revise && verdict?.approved === false && labels.includes(ctx.labels.managed);
      const capReached = reviseEligible && rounds >= 2;
      const handoff = reviseEligible && !capReached
        ? `\n\n${WORKFLOW_MENTION} please address the numbered findings above.`
        : capReached
          ? '\n\nRevision cycle cap reached — leaving the remaining findings to human review. This PR now carries the `needs-human` label; address the findings and re-run the review (an approval clears it), or merge or close by hand.'
          : '';

      // 3. Submit as a COMMENT review (never REQUEST_CHANGES: the Actions
      // dispatcher fires pr-revise on any changes-requested review, which
      // would bypass the cap and label rules the handoff enforces).
      const inline = await anchoredFindings(workspaceAt, body);
      const submission = await submitPrReview(repoRoot, p.pr, {
        event: verdict?.approved === true ? 'APPROVE' : 'COMMENT',
        body: `Advisory review by the pr-review workflow — the human merge decision stands either way.\n\n${body}${handoff}`,
        ...(inline.length > 0 ? { comments: inline } : {}),
      }, auth);

      // 4. Reconcile the needs-human label with the outcome. A failed
      // submission leaves the same visible trace, best effort — the comment
      // rides a different endpoint, so one failing does not imply the other.
      if (!submission.ok) {
        await setPrLabels(repoRoot, p.pr, { add: [ctx.labels.needsHuman] }, auth);
        await commentOnPr(repoRoot, p.pr,
          `The review was written but could not be submitted (${submission.detail}); this PR now carries the \`needs-human\` label. Re-run the PR review workflow, or review by hand — a later successful review clears the label.`,
          auth);
      } else if (capReached) {
        await setPrLabels(repoRoot, p.pr, { add: [ctx.labels.needsHuman] }, auth);
      } else if (labels.includes(ctx.labels.needsHuman)) {
        await setPrLabels(repoRoot, p.pr, { remove: [ctx.labels.needsHuman] }, auth);
      }

      // 5. Resolve the prior threads this pass marked ADDRESSED.
      const resolvedCount = submission.ok
        ? await resolveAddressedThreads(repoRoot, body, gathered?.resolvable_threads ?? [], auth)
        : 0;

      // 6. An APPROVE on a managed PR arms auto-merge. The verdict is the
      // signal, not the review event, so this fires even where GitHub
      // degraded the approval to a comment-state review on the token's own PR.
      const merge = p.merge && submission.ok && verdict?.approved === true && labels.includes(ctx.labels.managed)
        ? await enableAutoMerge(repoRoot, p.pr, auth)
        : undefined;

      // 7. Report what landed.
      return {
        posted: submission.ok,
        review_event: submission.event ?? '',
        inline_count: submission.inlineCount ?? 0,
        resolved_count: resolvedCount,
        revision_requested: reviseEligible && !capReached,
        ...(capReached ? { needs_human: true } : {}),
        ...(merge !== undefined ? { merge_armed: merge.ok, merge_detail: merge.detail } : {}),
        detail: `${verdict?.detail ?? ''}${capReached
          ? '; revision cap reached — waiting on human'
          : reviseEligible ? '; revision requested' : ''}; ${submission.detail}`
          + (resolvedCount > 0 ? `; resolved ${resolvedCount} addressed thread(s)` : '')
          + (merge !== undefined ? `; ${merge.detail}` : ''),
      };
    },
  });
}
