/**
 * What open pull requests already claim, for workflows that must not
 * redo work a human owes a decision on.
 *
 * A maintenance run defers findings in files an open maintenance PR
 * already touches. The answer comes from `gh`; when it cannot be given
 * — `gh` missing, unauthenticated, or no remote — the result is
 * `undefined` rather than an empty list, so a caller can tell "nothing
 * is claimed" apart from "I cannot see".
 *
 * @module git/pr
 */

import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/**
 * Files touched by open PRs whose head branch starts with `branchPrefix`,
 * repository-relative. `undefined` when the PR list cannot be read.
 */
export async function openPrFiles(
  repoRoot: string,
  branchPrefix: string,
): Promise<string[] | undefined> {
  try {
    const { stdout } = await exec(
      'gh', ['pr', 'list', '--state', 'open', '--json', 'headRefName,files'],
      { cwd: repoRoot },
    );
    const prs = JSON.parse(stdout) as { headRefName: string; files?: { path: string }[] }[];
    return prs
      .filter((pr) => pr.headRefName.startsWith(branchPrefix))
      .flatMap((pr) => (pr.files ?? []).map((file) => file.path));
  } catch {
    return undefined;
  }
}

/** One piece of human review feedback on a pull request. */
export interface PrComment {
  /** Review-comment id, present only for diff-anchored comments — the handle `replyToReviewComment` threads under. */
  id?: number;
  author: string;
  /**
   * The author's relationship to the repository, as GitHub stamps it
   * (OWNER, MEMBER, COLLABORATOR, CONTRIBUTOR, NONE, …). Consumers that
   * treat comment text as instructions must gate on it: commenting
   * needs no permission, so on a public repository this field is the
   * only thing separating a maintainer's feedback from anyone else's.
   */
  authorAssociation: string;
  body: string;
  /** File and line, for review comments anchored to the diff. */
  path?: string;
  line?: number;
  /** Where the feedback lives: a review's body, the PR conversation, or a diff-anchored comment. */
  source?: 'review' | 'conversation' | 'inline';
  /** ISO timestamp the comment was created or the review submitted. */
  createdAt?: string;
}

/** A pull request's head branch and the human feedback on it. */
export interface PrFeedback {
  headRefName: string;
  /** True when the head branch lives in a fork, not this repository. */
  isCrossRepository: boolean;
  title: string;
  /** The PR description: stated intent, provenance, and `Closes #N` linkage. */
  body: string;
  /** Label names on the PR; consent gates read these. */
  labels: string[];
  comments: PrComment[];
}

/**
 * The most useful line of a failed `gh` invocation: the API's own
 * error from stderr when there is one, the generic exec message
 * otherwise. Node's exec error message is "Command failed: <cmd>" plus
 * stderr on later lines, so taking its first line alone reports the
 * command and discards the reason. Exported for tests.
 */
export function ghErrorDetail(error: unknown): string {
  // `gh api` prints the API's response body to STDOUT even on failure;
  // stderr carries only the bare status line ("gh: Unprocessable Entity
  // (HTTP 422)"), so the reason lives in the stdout JSON.
  const stdout = (error as { stdout?: string }).stdout;
  if (typeof stdout === 'string' && stdout.trim() !== '') {
    try {
      const body = JSON.parse(stdout) as { message?: string; errors?: unknown[] };
      if (typeof body.message === 'string' && body.message !== '') {
        const errors = Array.isArray(body.errors) && body.errors.length > 0
          ? ` — ${JSON.stringify(body.errors)}`
          : '';
        return `${body.message}${errors}`.slice(0, 400);
      }
    } catch {
      // Not JSON; fall through to stderr.
    }
  }
  const stderr = (error as { stderr?: string }).stderr;
  const fromStderr = typeof stderr === 'string'
    ? stderr.split('\n').map((line) => line.trim()).find((line) => line !== '')
    : undefined;
  const message = error instanceof Error ? (error.message.split('\n')[0] ?? '') : String(error);
  return (fromStderr ?? message).slice(0, 400);
}

/**
 * Everything a failed `gh` invocation said, across message, stdout,
 * and stderr, for callers that pattern-match the failure kind: the
 * API's reason arrives on stdout, so a regex over the message alone
 * never sees it.
 */
function ghErrorText(error: unknown): string {
  return [
    error instanceof Error ? error.message : String(error),
    (error as { stdout?: string }).stdout ?? '',
    (error as { stderr?: string }).stderr ?? '',
  ].join('\n');
}

function ghEnv(token?: string): NodeJS.ProcessEnv | undefined {
  return token !== undefined ? { ...process.env, GH_TOKEN: token } : undefined;
}

/**
 * The review feedback on one pull request: submitted review bodies,
 * conversation comments, and diff-anchored review comments with their
 * file and line. `undefined` when it cannot be read.
 */
export async function prFeedback(
  repoRoot: string,
  prNumber: number,
  options: { token?: string } = {},
): Promise<PrFeedback | undefined> {
  const env = ghEnv(options.token);
  const opts = { cwd: repoRoot, ...(env !== undefined ? { env } : {}) };
  try {
    const { stdout } = await exec(
      'gh', ['pr', 'view', String(prNumber), '--json', 'headRefName,isCrossRepository,title,body,labels,reviews,comments'], opts);
    const view = JSON.parse(stdout) as {
      headRefName: string; isCrossRepository?: boolean; title: string; body?: string;
      labels?: { name?: string }[];
      reviews?: { author?: { login?: string }; authorAssociation?: string; body?: string; submittedAt?: string }[];
      comments?: { author?: { login?: string }; authorAssociation?: string; body?: string; createdAt?: string }[];
    };
    const { stdout: lineJson } = await exec(
      'gh', ['api', `repos/{owner}/{repo}/pulls/${prNumber}/comments`], opts);
    const lineComments = JSON.parse(lineJson) as {
      id?: number; user?: { login?: string }; author_association?: string;
      body?: string; path?: string; line?: number | null; created_at?: string;
    }[];
    const comments: PrComment[] = [
      ...(view.reviews ?? []).filter((r) => (r.body ?? '') !== '')
        .map((r) => ({
          author: r.author?.login ?? '', authorAssociation: r.authorAssociation ?? 'NONE', body: r.body ?? '',
          source: 'review' as const,
          ...(r.submittedAt !== undefined ? { createdAt: r.submittedAt } : {}),
        })),
      ...(view.comments ?? []).filter((c) => (c.body ?? '') !== '')
        .map((c) => ({
          author: c.author?.login ?? '', authorAssociation: c.authorAssociation ?? 'NONE', body: c.body ?? '',
          source: 'conversation' as const,
          ...(c.createdAt !== undefined ? { createdAt: c.createdAt } : {}),
        })),
      ...lineComments.filter((c) => (c.body ?? '') !== '').map((c) => ({
        ...(c.id !== undefined ? { id: c.id } : {}),
        author: c.user?.login ?? '',
        authorAssociation: c.author_association ?? 'NONE',
        body: c.body ?? '',
        ...(c.path !== undefined ? { path: c.path } : {}),
        ...(c.line != null ? { line: c.line } : {}),
        source: 'inline' as const,
        ...(c.created_at !== undefined ? { createdAt: c.created_at } : {}),
      })),
    ];
    const labels = (view.labels ?? []).map((label) => label.name ?? '').filter((name) => name !== '');
    return { headRefName: view.headRefName, isCrossRepository: view.isCrossRepository ?? true, title: view.title, body: view.body ?? '', labels, comments };
  } catch {
    return undefined;
  }
}

/** One review comment anchored to a diff line (new-file side). */
export interface ReviewInlineComment {
  path: string;
  line: number;
  body: string;
}

/** A pull-request review to submit as one unit. */
export interface ReviewSubmission {
  event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
  body: string;
  /** Findings to anchor inline on the diff; validate lines with `commentableDiffLines` first. */
  comments?: ReviewInlineComment[];
  /**
   * The body to submit instead when the API rejects the inline comments,
   * for a caller whose `body` leaves out what the inline comments carry.
   * Absent, the body-only resubmission reuses `body`.
   */
  bodyWithoutComments?: string;
}

/**
 * The new-file line numbers a review comment can anchor to, per path:
 * every added or context line the unified diff shows. GitHub rejects a
 * whole review when any inline comment names a line outside the diff,
 * so callers filter against this before submitting.
 */
export function commentableDiffLines(diff: string): Map<string, Set<number>> {
  const lines = new Map<string, Set<number>>();
  let path: string | undefined;
  let newLine = 0;
  let inHunk = false;
  for (const line of diff.replace(/\n$/, '').split('\n')) {
    if (line.startsWith('diff --git')) {
      path = undefined;
      inHunk = false;
      continue;
    }
    // Header detection is gated on hunk state: inside a hunk an added
    // line whose content begins `++` also renders as `+++ …`.
    if (!inHunk && line.startsWith('+++ ')) {
      path = line.startsWith('+++ b/') ? line.slice(6) : undefined;
      continue;
    }
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      newLine = Number(hunk[1]);
      inHunk = path !== undefined;
      continue;
    }
    if (!inHunk || path === undefined) continue;
    // An empty string counts as context: some transports strip the
    // leading space from blank context lines, and skipping them would
    // shift every later line number in the hunk.
    if (line.startsWith('+') || line.startsWith(' ') || line === '') {
      let set = lines.get(path);
      if (set === undefined) {
        set = new Set();
        lines.set(path, set);
      }
      set.add(newLine);
      newLine += 1;
    }
    // A removed line advances only the old file; a `\ No newline` marker advances neither.
  }
  return lines;
}

/**
 * Delete the token's leftover PENDING review on the pull request, if
 * one exists. A review POST that fails on its event — approving your
 * own PR, for instance — can leave the review behind as pending, and
 * GitHub allows one pending review per author, so every later POST
 * 422s until it is discarded; the leftover survives across runs.
 * Pending reviews are visible only to their author, so any PENDING
 * entry in the authed listing is the token's own.
 */
async function discardPendingReview(
  prNumber: number,
  opts: { cwd: string; env?: NodeJS.ProcessEnv },
): Promise<string | undefined> {
  try {
    const { stdout } = await exec('gh', ['api', `repos/{owner}/{repo}/pulls/${prNumber}/reviews`], opts);
    const pending = (JSON.parse(stdout) as { id?: number; state?: string }[])
      .find((entry) => entry.state === 'PENDING');
    if (pending?.id === undefined) return undefined;
    await exec('gh', [
      'api', `repos/{owner}/{repo}/pulls/${prNumber}/reviews/${pending.id}`, '--method', 'DELETE',
    ], opts);
    return `discarded leftover pending review ${pending.id}`;
  } catch {
    return undefined;
  }
}

/**
 * Submit one pull-request review: verdict, body, and any inline
 * comments, in a single API call. Degrades rather than fails: an
 * APPROVE or REQUEST_CHANGES the API refuses (a token cannot review its
 * own PR) is resubmitted as a COMMENT review, and inline comments the
 * API rejects are dropped for a body-only review; `detail` names every
 * degradation taken.
 */
export async function submitPrReview(
  repoRoot: string,
  prNumber: number,
  review: ReviewSubmission,
  options: { token?: string } = {},
): Promise<{ ok: boolean; event?: string; inlineCount?: number; detail: string }> {
  const env = ghEnv(options.token);
  const opts = { cwd: repoRoot, ...(env !== undefined ? { env } : {}) };

  const attempt = async (event: ReviewSubmission['event'], comments: ReviewInlineComment[], body: string) => {
    const dir = await mkdtemp(join(tmpdir(), 'cycgraph-review-'));
    const payloadAt = join(dir, 'review.json');
    try {
      await writeFile(payloadAt, JSON.stringify({
        event,
        body,
        ...(comments.length > 0
          ? { comments: comments.map((c) => ({ path: c.path, line: c.line, side: 'RIGHT', body: c.body })) }
          : {}),
      }));
      await exec('gh', [
        'api', `repos/{owner}/{repo}/pulls/${prNumber}/reviews`,
        '--method', 'POST', '--input', payloadAt,
      ], opts);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };

  let event = review.event;
  let comments = review.comments ?? [];
  let body = review.body;
  const degradations: string[] = [];
  for (let tries = 0; tries < 3; tries += 1) {
    // Idempotent per attempt: clears both a leftover from a previous
    // run and one this loop's own failed attempt just created.
    const discarded = await discardPendingReview(prNumber, opts);
    if (discarded !== undefined) degradations.push(discarded);
    try {
      await attempt(event, comments, body);
      return {
        ok: true,
        event,
        inlineCount: comments.length,
        detail: `submitted ${event} review with ${comments.length} inline comment(s)`
          + (degradations.length > 0 ? ` (${degradations.join('; ')})` : ''),
      };
    } catch (error) {
      // A token reviewing its own PR may neither approve nor request
      // changes; the verdict then rides the body of a COMMENT review.
      if (event !== 'COMMENT' && /your own pull request/i.test(ghErrorText(error))) {
        degradations.push(`${event} refused on own PR, submitted as COMMENT`);
        event = 'COMMENT';
        continue;
      }
      if (comments.length > 0) {
        degradations.push(`inline comments rejected (${ghErrorDetail(error)}), `
          + (review.bodyWithoutComments !== undefined ? 'moved into the body' : 'kept in the body'));
        comments = [];
        body = review.bodyWithoutComments ?? body;
        continue;
      }
      return {
        ok: false,
        detail: `review not submitted: ${ghErrorDetail(error)}`
          + (degradations.length > 0 ? ` (after: ${degradations.join('; ')})` : ''),
      };
    }
  }
  return { ok: false, detail: `review not submitted after degrading every optional part (${degradations.join('; ')})` };
}

/** Comment on a pull request; the failure's message when it cannot. */
export async function commentOnPr(
  repoRoot: string,
  prNumber: number,
  body: string,
  options: { token?: string } = {},
): Promise<{ ok: boolean; detail: string }> {
  const env = ghEnv(options.token);
  try {
    await exec('gh', ['pr', 'comment', String(prNumber), '--body', body],
      { cwd: repoRoot, ...(env !== undefined ? { env } : {}) });
    return { ok: true, detail: 'commented' };
  } catch (error) {
    return { ok: false, detail: ghErrorDetail(error) };
  }
}

/**
 * Reply inside an existing review-comment thread, so the response sits
 * beside the finding it answers instead of in the PR timeline.
 */
export async function replyToReviewComment(
  repoRoot: string,
  prNumber: number,
  commentId: number,
  body: string,
  options: { token?: string } = {},
): Promise<{ ok: boolean; detail: string }> {
  const env = ghEnv(options.token);
  try {
    await exec('gh', [
      'api', `repos/{owner}/{repo}/pulls/${prNumber}/comments/${commentId}/replies`,
      '--method', 'POST', '-f', `body=${body}`,
    ], { cwd: repoRoot, ...(env !== undefined ? { env } : {}) });
    return { ok: true, detail: `replied in thread of comment ${commentId}` };
  } catch (error) {
    return { ok: false, detail: ghErrorDetail(error) };
  }
}

/**
 * Comment on a whole file of a pull request rather than one line: the
 * comment opens its own review thread, which can be replied to and
 * resolved like a line comment. The file must be part of the pull
 * request's diff at `commitId`, which is the head the comment is made
 * against. Returns the new comment's REST id when it lands.
 */
export async function commentOnPrFile(
  repoRoot: string,
  prNumber: number,
  comment: { commitId: string; path: string; body: string },
  options: { token?: string } = {},
): Promise<{ ok: boolean; id?: number; detail: string }> {
  const env = ghEnv(options.token);
  try {
    const { stdout } = await exec('gh', [
      'api', `repos/{owner}/{repo}/pulls/${prNumber}/comments`,
      '--method', 'POST',
      '-f', `body=${comment.body}`,
      '-f', `commit_id=${comment.commitId}`,
      '-f', `path=${comment.path}`,
      '-f', 'subject_type=file',
    ], { cwd: repoRoot, ...(env !== undefined ? { env } : {}) });
    const created = JSON.parse(stdout) as { id?: number };
    return {
      ok: true,
      ...(created.id !== undefined ? { id: created.id } : {}),
      detail: `commented on ${comment.path}`,
    };
  } catch (error) {
    return { ok: false, detail: ghErrorDetail(error) };
  }
}

/** One comment inside a review thread. */
export interface ReviewThreadComment {
  /** REST id, the handle `replyToReviewComment` threads under. */
  id?: number;
  author: string;
  /** The author's relationship to the repository; gate on it before treating the body as instructions. */
  authorAssociation: string;
  body: string;
  /** Whether the token's own identity wrote the comment. */
  viewerDidAuthor: boolean;
  /** ISO timestamp the comment was created. */
  createdAt?: string;
}

/** One review-comment thread on a pull request: its anchor, state, and conversation. */
export interface ReviewThread {
  /** GraphQL node id, the handle `resolveReviewThread` takes. */
  id: string;
  isResolved: boolean;
  /** True when later commits changed the code the thread was anchored on. */
  isOutdated: boolean;
  path?: string;
  /** New-file line the thread sits on; absent once the thread is outdated. */
  line?: number;
  /** The line the thread was first anchored on, which survives outdating. */
  originalLine?: number;
  /** The diff hunk around the first comment, ending at its anchored line. */
  diffHunk?: string;
  /** Every comment in the thread, oldest first. */
  comments: ReviewThreadComment[];
  /** The thread's first comment: its body carries any finding marker. */
  body: string;
  /** Whether the token's own identity opened the thread. */
  viewerDidAuthor: boolean;
  /** REST id of the first comment, for threaded replies. */
  commentId?: number;
  /** GraphQL id of the review that submitted the first comment. */
  reviewId?: string;
  /** ISO timestamp of the first comment. */
  createdAt?: string;
}

/** The repository's owner and name, resolved through `gh`. */
async function repoSlug(
  repoRoot: string,
  env: NodeJS.ProcessEnv | undefined,
): Promise<{ owner: string; name: string } | undefined> {
  try {
    const { stdout } = await exec('gh', ['repo', 'view', '--json', 'owner,name'],
      { cwd: repoRoot, ...(env !== undefined ? { env } : {}) });
    const view = JSON.parse(stdout) as { owner?: { login?: string }; name?: string };
    return view.owner?.login !== undefined && view.name !== undefined
      ? { owner: view.owner.login, name: view.name }
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The review-comment threads on a pull request. GraphQL is the only
 * surface that exposes thread identity and resolution state, so this
 * is where resolution handles come from. `undefined` when they cannot
 * be read — treat as "cannot see", never as "no threads".
 */
export async function listReviewThreads(
  repoRoot: string,
  prNumber: number,
  options: { token?: string } = {},
): Promise<ReviewThread[] | undefined> {
  const env = ghEnv(options.token);
  const slug = await repoSlug(repoRoot, env);
  if (slug === undefined) return undefined;
  try {
    const query = 'query($owner:String!,$name:String!,$pr:Int!){'
      + 'repository(owner:$owner,name:$name){pullRequest(number:$pr){'
      + 'reviewThreads(first:100){nodes{id isResolved isOutdated path line originalLine '
      + 'comments(first:50){nodes{body databaseId viewerDidAuthor createdAt authorAssociation '
      + 'author{login} diffHunk pullRequestReview{id}}}}}}}}';
    const { stdout } = await exec('gh', [
      'api', 'graphql',
      '-f', `query=${query}`,
      '-f', `owner=${slug.owner}`, '-f', `name=${slug.name}`, '-F', `pr=${prNumber}`,
    ], { cwd: repoRoot, ...(env !== undefined ? { env } : {}) });
    const parsed = JSON.parse(stdout) as {
      data?: { repository?: { pullRequest?: { reviewThreads?: { nodes?: {
        id?: string; isResolved?: boolean; isOutdated?: boolean; path?: string | null;
        line?: number | null; originalLine?: number | null;
        comments?: { nodes?: {
          body?: string; databaseId?: number; viewerDidAuthor?: boolean;
          createdAt?: string; authorAssociation?: string; author?: { login?: string } | null;
          diffHunk?: string; pullRequestReview?: { id?: string } | null;
        }[] };
      }[] } } } };
    };
    const nodes = parsed.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
    return nodes.flatMap((node) => {
      if (node.id === undefined) return [];
      const nodes = node.comments?.nodes ?? [];
      const first = nodes[0];
      return [{
        id: node.id,
        isResolved: node.isResolved === true,
        isOutdated: node.isOutdated === true,
        ...(node.path != null ? { path: node.path } : {}),
        ...(node.line != null ? { line: node.line } : {}),
        ...(node.originalLine != null ? { originalLine: node.originalLine } : {}),
        ...(first?.diffHunk !== undefined ? { diffHunk: first.diffHunk } : {}),
        comments: nodes.map((comment) => ({
          ...(comment.databaseId !== undefined ? { id: comment.databaseId } : {}),
          author: comment.author?.login ?? '',
          authorAssociation: comment.authorAssociation ?? 'NONE',
          body: comment.body ?? '',
          viewerDidAuthor: comment.viewerDidAuthor === true,
          ...(comment.createdAt !== undefined ? { createdAt: comment.createdAt } : {}),
        })),
        body: first?.body ?? '',
        viewerDidAuthor: first?.viewerDidAuthor === true,
        ...(first?.databaseId !== undefined ? { commentId: first.databaseId } : {}),
        ...(first?.pullRequestReview?.id !== undefined ? { reviewId: first.pullRequestReview.id } : {}),
        ...(first?.createdAt !== undefined ? { createdAt: first.createdAt } : {}),
      }];
    });
  } catch {
    return undefined;
  }
}

/** Mark one review thread resolved; the failure's message when it cannot. */
export async function resolveReviewThread(
  repoRoot: string,
  threadId: string,
  options: { token?: string } = {},
): Promise<{ ok: boolean; detail: string }> {
  const env = ghEnv(options.token);
  try {
    await exec('gh', [
      'api', 'graphql',
      '-f', 'query=mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}',
      '-f', `id=${threadId}`,
    ], { cwd: repoRoot, ...(env !== undefined ? { env } : {}) });
    return { ok: true, detail: `resolved thread ${threadId}` };
  } catch (error) {
    return { ok: false, detail: ghErrorDetail(error) };
  }
}

/**
 * Enable auto-merge on a pull request so it merges the moment its
 * required checks pass; a PR GitHub reports as already mergeable is
 * merged directly instead. Squash keeps the PR title — for a
 * single-commit delivery, the change's own subject — as the merge
 * subject, and the head branch is deleted on merge.
 */
export async function enableAutoMerge(
  repoRoot: string,
  prNumber: number,
  options: { token?: string } = {},
): Promise<{ ok: boolean; merged?: 'auto' | 'now'; detail: string }> {
  const env = ghEnv(options.token);
  const opts = { cwd: repoRoot, ...(env !== undefined ? { env } : {}) };
  try {
    await exec('gh', ['pr', 'merge', String(prNumber), '--auto', '--squash', '--delete-branch'], opts);
    return { ok: true, merged: 'auto', detail: 'auto-merge enabled; merges when checks pass' };
  } catch (error) {
    const reason = ghErrorDetail(error);
    // "Clean status" means the checks are already green, so there is
    // nothing to arm — merge now. Every other failure also gets one
    // direct attempt: auto-merge disabled in repository settings is
    // survivable when the checks happen to be done.
    try {
      await exec('gh', ['pr', 'merge', String(prNumber), '--squash', '--delete-branch'], opts);
      return { ok: true, merged: 'now', detail: 'merged directly (checks already green)' };
    } catch (directError) {
      const directReason = ghErrorDetail(directError);
      return { ok: false, detail: `auto-merge failed (${reason}); direct merge failed (${directReason})` };
    }
  }
}

/**
 * Add and remove labels on a pull request, best effort: labels being
 * added are created on the repository first when missing, a removal of
 * an absent label is not an error, and the result names anything that
 * did not stick. Workflows use this to keep a PR's visible state
 * honest — a label is state the PR list can filter on, unlike a
 * comment buried in the timeline.
 */
export async function setPrLabels(
  repoRoot: string,
  prNumber: number,
  labels: { add?: string[]; remove?: string[] },
  options: { token?: string } = {},
): Promise<{ ok: boolean; detail: string }> {
  const env = ghEnv(options.token);
  const opts = { cwd: repoRoot, ...(env !== undefined ? { env } : {}) };
  const failures: string[] = [];
  for (const label of labels.add ?? []) {
    await exec('gh', ['label', 'create', label], opts).catch(() => undefined);
    try {
      await exec('gh', ['pr', 'edit', String(prNumber), '--add-label', label], opts);
    } catch (error) {
      failures.push(`add ${label}: ${ghErrorDetail(error)}`);
    }
  }
  for (const label of labels.remove ?? []) {
    try {
      await exec('gh', ['pr', 'edit', String(prNumber), '--remove-label', label], opts);
    } catch {
      // Removing an absent label is the ordinary no-op.
    }
  }
  return failures.length === 0
    ? { ok: true, detail: 'labels updated' }
    : { ok: false, detail: failures.join('; ') };
}
