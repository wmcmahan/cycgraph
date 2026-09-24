/**
 * What the reviewer and the reviser read from a pull request's review
 * history, and how it is laid out for them.
 *
 * Each open review thread is one item: its anchor, the code it sits on,
 * and its whole conversation in order, so an agent sees a finding once
 * together with every reply to it. Top-level feedback is a separate item
 * kind, because GitHub gives a review body or a conversation comment no
 * thread to reply in or resolve. Pure logic over what `gh` returned.
 *
 * @module maintenance/review-threads
 */

import type { PrComment, ReviewThread, ReviewThreadComment } from '@cycgraph/tools/git';
import { TRUSTED_ASSOCIATIONS, WORKFLOW_MENTION } from './repo.js';
import { FOOTER_OPEN } from './provenance.js';
import { isFindingThread, markerKindOf, parseOverallFindings, parseReviewFindings, withoutMarkers } from './review-findings.js';
import type { ReviewFinding } from './review-findings.js';

/** The visible opening of every pr-review review body. */
export const ADVISORY_PREFIX = 'Advisory review by the pr-review workflow';

/** The visible opening of every pr-revise summary comment. */
export const REVISION_PREFIX = 'Addressed the review feedback in the latest commit.';

/** Diff-hunk lines shown above a thread: the anchored line and the ones before it. */
const HUNK_TAIL = 8;

/** An open review thread with its label and the comments an agent may read. */
export interface LabeledThread {
  /** `T<n>`, the handle the agent's reply or verdict line names. */
  label: string;
  thread: ReviewThread;
  /** The thread's trusted comments, oldest first. */
  comments: ReviewThreadComment[];
}

/** A top-level feedback item with its label. */
export interface LabeledComment {
  /** `C<n>`, the handle the reviser's reply names. */
  label: string;
  comment: PrComment;
}

/** Who reads the history: the wording of the workflows' own comments depends on it. */
export type Reader = 'reviewer' | 'reviser';

/** Whether a comment's author may steer an agent: a trusted association, and no bot. */
export function isTrustedAuthor(comment: { author: string; authorAssociation: string }): boolean {
  return TRUSTED_ASSOCIATIONS.has(comment.authorAssociation) && !comment.author.endsWith('[bot]');
}

/** Whether a top-level comment is a pr-review review body. */
export function isAdvisoryReview(body: string): boolean {
  return markerKindOf(body) === 'review' || body.startsWith(ADVISORY_PREFIX);
}

/**
 * The earlier pr-review bodies on a pull request, oldest first. Only
 * trusted authors count: the marker is plain text anyone can post, and an
 * earlier review both spends the rounds cap and supplies the overall
 * points the next pass judges.
 */
export function priorAdvisoryReviews(comments: readonly PrComment[]): PrComment[] {
  return comments.filter((comment) =>
    comment.source !== 'inline' && isTrustedAuthor(comment) && isAdvisoryReview(comment.body));
}

/** Whether a top-level comment is a pr-revise summary. */
function isRevisionSummary(body: string): boolean {
  return markerKindOf(body) === 'revision' || body.startsWith(REVISION_PREFIX);
}

/** Whose words a comment is, named for the given reader. */
function speaker(comment: { author: string; body: string }, reader: Reader, opener: boolean): string {
  const kind = markerKindOf(comment.body);
  const fromReviewer = kind === 'finding' || kind === 'verify' || kind === 'review'
    || (opener && isFindingThread(comment.body));
  if (fromReviewer) return reader === 'reviewer' ? 'you, in an earlier review' : 'reviewer (pr-review)';
  if (kind === 'reply' || kind === 'revision') return reader === 'reviser' ? 'you, in an earlier revision' : 'reviser (pr-revise)';
  return comment.author;
}

/**
 * A comment body as an agent reads it: markers and the legacy visible
 * finding prefix removed, and the collapsed evidence block unfolded into
 * plain text.
 */
function readable(body: string): string {
  return withoutMarkers(body)
    .replace(/^\*\*Finding \d+\*\*\s*[—–-]?\s*/, '')
    .replace(/<details><summary>Evidence<\/summary>\s*/g, 'Evidence:\n')
    .replace(/\s*<\/details>/g, '')
    .trim();
}

/** Indent every line after the first, so a multi-line comment stays inside its bullet. */
function hanging(text: string): string {
  return text.split('\n').map((line, i) => (i === 0 || line === '' ? line : `  ${line}`)).join('\n');
}

/** One open thread, rendered: its anchor, the code it sits on, and its conversation. */
export function renderThread(item: LabeledThread, reader: Reader): string {
  const { thread } = item;
  const path = thread.path ?? 'unknown file';
  const anchor = thread.line !== undefined
    ? `${path}:${thread.line}`
    : thread.originalLine !== undefined
      ? `${path}, originally line ${thread.originalLine}`
      : `${path} (a comment on the whole file)`;
  const outdated = thread.isOutdated ? ' (outdated: the code has changed since; the hunk shows where the thread was left)' : '';
  const hunk = thread.diffHunk !== undefined
    ? ['```diff', ...thread.diffHunk.split('\n').slice(-HUNK_TAIL), '```']
    : [];
  const conversation = item.comments.map((comment, index) =>
    `- ${speaker(comment, reader, index === 0)}: ${hanging(readable(comment.body))}`);
  return [`${item.label} · ${anchor}${outdated}`, ...hunk, ...conversation].join('\n');
}

/** Label the given threads `T1…Tn`, keeping only their trusted comments. */
function labelThreads(threads: readonly ReviewThread[]): LabeledThread[] {
  return threads.map((thread, index) => ({
    label: `T${index + 1}`,
    thread,
    comments: thread.comments.filter(isTrustedAuthor),
  }));
}

/**
 * The open threads a verification pass judges: unresolved finding threads
 * this workflow's own token opened, from any earlier round. Human threads
 * are never among them, so the reviewer never resolves a human's thread.
 */
export function verificationThreads(threads: readonly ReviewThread[]): LabeledThread[] {
  return labelThreads(threads.filter((thread) =>
    !thread.isResolved && thread.viewerDidAuthor && isFindingThread(thread.body)));
}

/** A top-level comment's text for an agent: the workflow's own framing lines removed. */
export function topLevelText(body: string): string {
  return withoutMarkers(body)
    .split('\n')
    .filter((line) => !line.startsWith(ADVISORY_PREFIX) && !line.includes(WORKFLOW_MENTION) && !line.startsWith(FOOTER_OPEN))
    .join('\n')
    .trim();
}

/**
 * The overall points the latest pr-review body left open, which a
 * verification pass judges as `P<n>` by their order there. A body posted
 * before findings moved onto the diff lists every finding numbered, and
 * the ones with a line already have threads, so from such a body only
 * the findings without a line count.
 */
export function priorTopLevelFindings(latestAdvisoryBody: string): ReviewFinding[] {
  return markerKindOf(latestAdvisoryBody) === 'review'
    ? parseOverallFindings(latestAdvisoryBody)
    : parseReviewFindings(topLevelText(latestAdvisoryBody)).filter((finding) => finding.line === undefined);
}

/**
 * A short handle for a top-level item, for the summary comment that
 * answers it: the item's first line, or a name for a pr-review body,
 * whose first lines are only framing.
 */
export function excerptOf(body: string): string {
  if (isAdvisoryReview(body)) return 'the review summary';
  const first = withoutMarkers(body).split('\n').find((line) => line.trim() !== '') ?? '';
  return first.trim().length > 120 ? `${first.trim().slice(0, 117)}...` : first.trim();
}

/** What a revision addresses: the open threads and the top-level feedback. */
export interface RevisionFeedback {
  threads: LabeledThread[];
  topLevel: LabeledComment[];
}

/**
 * The feedback a revision must address.
 *
 * Threads: every unresolved thread a trusted author opened, with its
 * trusted conversation, so the reviser sees each finding once beside
 * every reply to it. Top level: trusted review bodies and conversation
 * comments posted since the last revision, never the workflows' own
 * summaries or notices, and at most the latest pr-review body, only when
 * it still carries findings of its own.
 */
export function revisionFeedback(threads: readonly ReviewThread[], comments: readonly PrComment[]): RevisionFeedback {
  const open = threads.filter((thread) => {
    const opener = thread.comments[0];
    return !thread.isResolved && opener !== undefined && isTrustedAuthor(opener);
  });

  const topLevel = comments.filter((comment) => comment.source !== 'inline' && isTrustedAuthor(comment));
  const lastRevisionAt = topLevel
    .filter((comment) => isRevisionSummary(comment.body))
    .reduce<string | undefined>((latest, comment) =>
      comment.createdAt !== undefined && (latest === undefined || comment.createdAt > latest) ? comment.createdAt : latest,
    undefined);
  const since = topLevel.filter((comment) => {
    const kind = markerKindOf(comment.body);
    if (isRevisionSummary(comment.body) || kind === 'notice' || kind === 'reply') return false;
    return lastRevisionAt === undefined || comment.createdAt === undefined || comment.createdAt > lastRevisionAt;
  });
  const advisories = since.filter((comment) => isAdvisoryReview(comment.body));
  const latestAdvisory = advisories[advisories.length - 1];
  const kept = since.filter((comment) => !isAdvisoryReview(comment.body)
    || (comment === latestAdvisory && priorTopLevelFindings(comment.body).length > 0));

  return {
    threads: labelThreads(open),
    topLevel: kept.map((comment, index) => ({ label: `C${index + 1}`, comment })),
  };
}

/** The reviser's instruction: every feedback item, labeled, threads first. */
export function renderRevisionFeedback(feedback: RevisionFeedback): string {
  const threads = feedback.threads.length > 0
    ? [
      'Open review threads. Each is anchored to a line, shown with the code it was left on and its whole conversation in order:',
      '',
      ...feedback.threads.flatMap((item) => [renderThread(item, 'reviser'), '']),
    ]
    : [];
  const topLevel = feedback.topLevel.length > 0
    ? [
      'Top-level feedback about the change as a whole:',
      '',
      ...feedback.topLevel.flatMap(({ label, comment }) => {
        const who = isAdvisoryReview(comment.body) ? 'review by reviewer (pr-review)' : `${comment.source === 'review' ? 'review' : 'comment'} by ${comment.author}`;
        const text = isAdvisoryReview(comment.body) ? topLevelText(comment.body) : withoutMarkers(comment.body);
        return [`${label} · ${who}`, text, ''];
      }),
    ]
    : [];
  return [...threads, ...topLevel].join('\n').trim();
}

/**
 * The verification brief: the open finding threads and earlier overall
 * points a re-review judges before looking at what changed. When the
 * threads could not be read, their state is unknown, so the brief says so
 * and asks for no thread judgments rather than implying none are open.
 */
export function verificationBrief(
  threads: readonly LabeledThread[],
  prior: readonly ReviewFinding[],
  options: { threadsUnreadable?: boolean } = {},
): string[] {
  const unreadable = options.threadsUnreadable === true;
  if (!unreadable && threads.length === 0 && prior.length === 0) {
    return ['A previous advisory review exists and every one of its findings has since been resolved; review the change as it stands.'];
  }
  const judge = prior.length > 0
    ? [unreadable
      ? 'FIRST judge each prior top-level finding (P) against the current tree, one line each, exactly as: P1: ADDRESSED — <evidence> or P1: UNRESOLVED — <what is still wrong>.'
      : 'FIRST judge each open finding thread (T) and each prior top-level finding (P) against the current tree, one line each, exactly as: T1: ADDRESSED — <evidence> or T1: UNRESOLVED — <what is still wrong>, and P1: ADDRESSED — … or P1: UNRESOLVED — … the same way.']
    : unreadable
      ? []
      : ['FIRST judge each open finding thread (T) against the current tree, one line each, exactly as: T1: ADDRESSED — <evidence> or T1: UNRESOLVED — <what is still wrong>.'];
  return [
    'A previous advisory review requested changes and a revision has since been pushed.',
    ...(unreadable
      ? ['Its review threads could not be read, so whether its line and file findings were addressed is unknown. Do not assume they were, and write no T lines. Check the tree yourself: any earlier problem that still stands is a new finding.']
      : []),
    ...judge,
    ...(!unreadable && threads.length > 0
      ? ['Each T line is posted as your reply inside that thread, and an ADDRESSED thread is then resolved, so write each one to stand alone and do not restate the file or line. Read each thread to its last comment: the reviser may have disputed the finding with evidence, and a dispute that holds up counts as ADDRESSED.']
      : []),
    `Then review anything the revision newly changed, numbering any new findings as usual.${unreadable
      ? (prior.length > 0 ? ' Never restate a P item as a new finding: its line already carries it forward.' : '')
      : ' Never restate a T or P item as a new finding: its line already carries it forward.'}`,
    ...(!unreadable && threads.length > 0 ? ['', 'Open finding threads:', '', ...threads.flatMap((item) => [renderThread(item, 'reviewer'), ''])] : []),
    ...(prior.length > 0
      ? ['Prior top-level findings:', ...prior.map((finding) =>
        [`P${finding.ordinal}. ${finding.text}`, ...finding.evidence.map((line) => `   ${line}`)].join('\n'))]
      : []),
  ];
}
