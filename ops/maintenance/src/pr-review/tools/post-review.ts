/**
 * post_review — submit the review on the PR.
 *
 * Submits the verdict as a real pull-request review. A finding on a line
 * the diff can hold is posted only as a comment on that line, and one on a
 * file the diff touches but no such line as a comment on the whole file,
 * each with its evidence folded beneath it. The review body keeps the
 * verdict, the summary, and an unnumbered list of what remains about the
 * change as a whole, including earlier overall points still open. An APPROVE
 * approves the PR (armed to auto-merge on a managed PR when `merge` is
 * on). A REVISE on a managed PR ends the body with the pr-revise trigger,
 * bounded by a rounds cap; past the cap, and on any inconclusive or failed
 * submission, the PR is labeled needs-human. A verification pass answers
 * each open finding thread inside it and resolves the ones it judged
 * addressed. Nothing is ever pushed.
 *
 * @module maintenance/pr-review/tools/post-review
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { tool } from '@cycgraph/orchestrator';
import {
  commentOnPr,
  commentOnPrFile,
  commentableDiffLines,
  enableAutoMerge,
  replyToReviewComment,
  resolveReviewThread,
  setPrLabels,
  submitPrReview,
} from '@cycgraph/tools/git';
import type { ReviewInlineComment } from '@cycgraph/tools/git';
import { composeReviewBody, inlineFindingBody, parseReviewFindings, parseThreadVerdicts, reviewMarker } from '../../shared/review-findings.js';
import type { PriorFinding, Provenance, ReviewFinding } from '../../shared/review-findings.js';
import { modelFor } from '../../shared/models.js';
import { dryRunPreview, provenanceFooter } from '../../shared/provenance.js';
import { ADVISORY_PREFIX } from '../../shared/review-threads.js';
import { WORKFLOW_MENTION, stripMentions } from '../../shared/repo.js';
import type { ReviewContext } from '../context.js';

const exec = promisify(execFile);

/** An open finding thread this pass may reply in and resolve, by its label. */
type ResolvableThread = { label: string; thread_id: string; comment_id?: number };

/**
 * Where each finding can sit on the diff. A finding whose line the diff
 * can hold goes on that line; one that names a file the diff touches, but
 * no line it can hold, goes on the whole file. The rest stay in the body.
 */
async function placeFindings(workspaceAt: string, review: string, provenance: Provenance): Promise<{
  onLine: Map<number, ReviewInlineComment>;
  onFile: ReviewFinding[];
}> {
  const { stdout: diff } = await exec('git', ['diff', 'refs/pr-review/base...HEAD'],
    { cwd: workspaceAt, maxBuffer: 64 * 1024 * 1024 }).catch(() => ({ stdout: '' }));
  const anchorable = commentableDiffLines(diff);
  const onLine = new Map<number, ReviewInlineComment>();
  const onFile: ReviewFinding[] = [];
  for (const finding of parseReviewFindings(review)) {
    if (finding.path === undefined || !anchorable.has(finding.path)) continue;
    if (finding.line !== undefined && anchorable.get(finding.path)!.has(finding.line)) {
      onLine.set(finding.ordinal, { path: finding.path, line: finding.line, body: inlineFindingBody(finding, { provenance }) });
    } else {
      onFile.push(finding);
    }
  }
  return { onLine, onFile };
}

/**
 * Post each file-level finding as its own comment on the file, and return
 * the ordinals that landed. They post before the review, so the review
 * body can list any that GitHub refused.
 */
async function postFileFindings(
  repoRoot: string,
  pr: number,
  findings: readonly ReviewFinding[],
  provenance: Provenance,
  auth: { token?: string },
): Promise<Set<number>> {
  const placed = new Set<number>();
  for (const finding of findings) {
    if (provenance.commit === undefined) break;
    const posted = await commentOnPrFile(repoRoot, pr,
      { commitId: provenance.commit, path: finding.path!, body: inlineFindingBody(finding, { onFile: true, provenance }) }, auth);
    if (posted.ok) placed.add(finding.ordinal);
  }
  return placed;
}

/** The body's note on how many findings sit on the diff. */
function placedNote(count: number): string[] {
  if (count === 0) return [];
  return [count === 1 ? '1 finding is posted as a comment on the diff.' : `${count} findings are posted as comments on the diff.`];
}

/** The commit the workspace is on, which is the PR head the review read. */
async function headCommit(workspaceAt: string): Promise<string | undefined> {
  return exec('git', ['rev-parse', 'HEAD'], { cwd: workspaceAt })
    .then(({ stdout }) => stdout.trim() || undefined)
    .catch(() => undefined);
}

/** The review body as posted: the marker, the advisory framing, the text, the notes, the handoff, and the footer. */
function framedBody(text: string, notes: readonly string[], handoff: string, provenance: Provenance, footer: string): string {
  return [
    reviewMarker('review', provenance),
    `${ADVISORY_PREFIX} — the human merge decision stands either way.`,
    '',
    text,
    ...(notes.length > 0 ? ['', ...notes] : []),
  ].join('\n') + handoff + (footer !== '' ? `\n\n${footer}` : '');
}

/** A judged earlier thread and the reply it gets. */
type ThreadAnswer = { thread: ResolvableThread; addressed: boolean; reply: string };

/**
 * The replies a verification pass owes: one per open finding thread it
 * judged, with whether to resolve it. Only threads the gather step handed
 * over are answered, so human threads never are.
 */
function threadAnswers(review: string, threads: readonly ResolvableThread[], provenance: Provenance): ThreadAnswer[] {
  const byLabel = new Map(threads.map((thread) => [thread.label, thread]));
  return parseThreadVerdicts(review).flatMap((verdict) => {
    const thread = byLabel.get(verdict.label);
    if (thread === undefined) return [];
    const reply = `${reviewMarker('verify', provenance)}\n${verdict.addressed ? 'Verified as addressed' : 'Still open'}: ${verdict.note}`.slice(0, 2_000);
    return [{ thread, addressed: verdict.addressed, reply }];
  });
}

/** Post each thread answer inside its thread, resolving the addressed ones. */
async function answerThreads(
  repoRoot: string,
  pr: number,
  answers: readonly ThreadAnswer[],
  auth: { token?: string },
): Promise<{ replied: number; resolved: number }> {
  let replied = 0;
  let resolved = 0;
  for (const { thread, addressed, reply } of answers) {
    if (thread.comment_id !== undefined && (await replyToReviewComment(repoRoot, pr, thread.comment_id, reply, auth)).ok) replied += 1;
    if (addressed && (await resolveReviewThread(repoRoot, thread.thread_id, auth)).ok) resolved += 1;
  }
  return { replied, resolved };
}

/** The review-submitting tool, bound to the clone. */
export function postReviewTool(c: ReviewContext) {
  const { workspaceAt, repoRoot, token, env, params: p, maintenance: ctx } = c;
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
        prior_findings?: PriorFinding[];
        threads_unreadable?: boolean;
      } | undefined;
      const labels = gathered?.labels ?? [];
      const rounds = gathered?.advisory_rounds ?? 0;

      // The review's provenance: the recorded run, the head it read, and
      // the model tier the reviewer runs on.
      const model = modelFor(env, 'high');
      const provenance: Provenance = {
        ...(env.provenance !== undefined ? { run: env.provenance.runId } : {}),
        ...(await headCommit(workspaceAt).then((commit) => (commit !== undefined ? { commit } : {}))),
        model,
      };

      // 1. Inconclusive review: label needs-human and post a plain trace
      // comment (not an advisory review — silence must never look like a
      // clean pass, and the advisory prefix is what counts rounds). A dry
      // run touches nothing and says what it would have done.
      if (verdict?.malformed === true) {
        const traceBody = `${reviewMarker('notice', provenance)}\n`
          + 'The automated review could not produce a verdict after two attempts (a diff-only fallback included), so this PR now carries the `needs-human` label and waits on you. '
          + 'CI checks still reflect build and test health on their own; review the diff yourself and merge or close, or re-run the PR review workflow to try again — a later successful review clears the label.';
        if (!p.comment) {
          return {
            posted: false,
            needs_human: true,
            detail: `dry run — ${verdict.detail ?? 'inconclusive review'}`,
            preview: dryRunPreview([
              { title: 'label', body: `add ${ctx.labels.needsHuman}` },
              { title: 'conversation comment', body: traceBody },
            ]),
          };
        }
        await setPrLabels(repoRoot, p.pr, { add: [ctx.labels.needsHuman] }, auth);
        const trace = await commentOnPr(repoRoot, p.pr, traceBody, auth);
        return { posted: false, needs_human: true, detail: `nothing posted — ${verdict.detail ?? 'inconclusive review'}; trace: ${trace.detail}` };
      }

      // 2. Build the body and the pr-revise handoff. Mentions inside the
      // review text are stripped — an echoed mention would re-trigger
      // workflows on arbitrary reviewer prose — and the one deliberate
      // trigger is the handoff below, only on a managed PR (GitHub
      // restricts that label to triage+ users) and only within the rounds
      // cap: past it, findings still post but the cycle hands to the human.
      const reviewText = stripMentions(String(review ?? '')).slice(0, 12_000);
      const reviseEligible = p.revise && verdict?.approved === false && labels.includes(ctx.labels.managed);
      const capReached = reviseEligible && rounds >= 2;
      const handoff = reviseEligible && !capReached
        ? `\n\n${WORKFLOW_MENTION} please address the open review threads and any findings above.`
        : capReached
          ? '\n\nRevision cycle cap reached — leaving the remaining findings to human review. This PR now carries the `needs-human` label; address the findings and re-run the review (an approval clears it), or merge or close by hand.'
          : '';

      // 3. Place the findings on the diff: whole-file ones post first as
      // their own comments, line ones ride the review. The body lists only
      // what sits nowhere on the diff; if GitHub rejects the line comments,
      // their findings join that list so none is lost.
      const { onLine, onFile } = await placeFindings(workspaceAt, reviewText, provenance);
      const footer = provenanceFooter('Reviewed at', {
        ...(provenance.commit !== undefined ? { commit: provenance.commit } : {}),
        model,
        ...(env.provenance?.runUrl !== undefined ? { runUrl: env.provenance.runUrl } : {}),
      });
      const prior = gathered?.prior_findings ?? [];
      const verdicts = parseThreadVerdicts(reviewText);
      const threadNote = gathered?.threads_unreadable === true
        ? ['The earlier review threads could not be read, so they were not judged and are left as they were.']
        : verdicts.length > 0
          ? [`Earlier threads: ${verdicts.filter((v) => v.addressed).length} addressed, ${verdicts.filter((v) => !v.addressed).length} still open. Each judgment is a reply in its thread.`]
          : [];
      const bodyFor = (placed: ReadonlySet<number>): string =>
        framedBody(composeReviewBody(reviewText, placed, prior), [...placedNote(placed.size), ...threadNote], handoff, provenance, footer);
      const event = verdict?.approved === true ? 'APPROVE' : 'COMMENT';
      const answers = threadAnswers(reviewText, gathered?.resolvable_threads ?? [], provenance);
      const armsMerge = p.merge && verdict?.approved === true && labels.includes(ctx.labels.managed);

      // A dry run stops here and returns everything it would post, built
      // by the same code, assuming every comment is accepted.
      if (!p.comment) {
        const fileComments = onFile.map((finding) => ({
          title: `file comment · ${finding.path}`,
          body: inlineFindingBody(finding, { onFile: true, provenance }),
        }));
        const labelChange = capReached
          ? `add ${ctx.labels.needsHuman}`
          : labels.includes(ctx.labels.needsHuman) ? `remove ${ctx.labels.needsHuman}` : undefined;
        return {
          posted: false,
          detail: `dry run — ${verdict?.detail ?? ''}`,
          preview: dryRunPreview([
            ...fileComments,
            ...[...onLine.values()].map((comment) => ({ title: `line comment · ${comment.path}:${comment.line}`, body: comment.body })),
            { title: `review (${event})`, body: bodyFor(new Set([...onLine.keys(), ...onFile.map((finding) => finding.ordinal)])) },
            ...answers.map((answer) => ({
              title: `reply in ${answer.thread.label}${answer.addressed ? ', then resolve it' : ''}`,
              body: answer.reply,
            })),
            ...(labelChange !== undefined ? [{ title: 'label', body: labelChange }] : []),
            ...(armsMerge ? [{ title: 'merge', body: 'arm auto-merge' }] : []),
          ]),
        };
      }

      // Submit as a COMMENT review, never REQUEST_CHANGES: the Actions
      // dispatcher fires pr-revise on any changes-requested review, which
      // would bypass the cap and label rules the handoff enforces.
      const onFilePlaced = await postFileFindings(repoRoot, p.pr, onFile, provenance, auth);
      const submission = await submitPrReview(repoRoot, p.pr, {
        event,
        body: bodyFor(new Set([...onLine.keys(), ...onFilePlaced])),
        ...(onLine.size > 0
          ? { comments: [...onLine.values()], bodyWithoutComments: bodyFor(onFilePlaced) }
          : {}),
      }, auth);

      // 4. Reconcile the needs-human label with the outcome. A failed
      // submission leaves the same visible trace, best effort — the comment
      // rides a different endpoint, so one failing does not imply the other.
      // The failure detail stays in the tool result: GitHub's error text
      // is not fit for a public PR.
      if (!submission.ok) {
        await setPrLabels(repoRoot, p.pr, { add: [ctx.labels.needsHuman] }, auth);
        await commentOnPr(repoRoot, p.pr,
          `${reviewMarker('notice', provenance)}\nSomething went wrong while submitting the automated review, so this PR now carries the \`needs-human\` label. Re-run the PR review workflow, or review by hand — a later successful review clears the label.`,
          auth);
      } else if (capReached) {
        await setPrLabels(repoRoot, p.pr, { add: [ctx.labels.needsHuman] }, auth);
      } else if (labels.includes(ctx.labels.needsHuman)) {
        await setPrLabels(repoRoot, p.pr, { remove: [ctx.labels.needsHuman] }, auth);
      }

      // 5. Answer the earlier threads this pass judged, resolving the addressed ones.
      const answered = submission.ok
        ? await answerThreads(repoRoot, p.pr, answers, auth)
        : { replied: 0, resolved: 0 };
      const resolvedCount = answered.resolved;

      // 6. An APPROVE on a managed PR arms auto-merge. The verdict is the
      // signal, not the review event, so this fires even where GitHub
      // degraded the approval to a comment-state review on the token's own PR.
      const merge = armsMerge && submission.ok
        ? await enableAutoMerge(repoRoot, p.pr, auth)
        : undefined;

      // 7. Report what landed.
      return {
        posted: submission.ok,
        review_event: submission.event ?? '',
        inline_count: submission.inlineCount ?? 0,
        thread_replies: answered.replied,
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
