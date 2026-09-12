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
}

/** A pull request's head branch and the human feedback on it. */
export interface PrFeedback {
  headRefName: string;
  title: string;
  /** Label names on the PR; consent gates read these. */
  labels: string[];
  comments: PrComment[];
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
      'gh', ['pr', 'view', String(prNumber), '--json', 'headRefName,title,labels,reviews,comments'], opts);
    const view = JSON.parse(stdout) as {
      headRefName: string; title: string;
      labels?: { name?: string }[];
      reviews?: { author?: { login?: string }; authorAssociation?: string; body?: string }[];
      comments?: { author?: { login?: string }; authorAssociation?: string; body?: string }[];
    };
    const { stdout: lineJson } = await exec(
      'gh', ['api', `repos/{owner}/{repo}/pulls/${prNumber}/comments`], opts);
    const lineComments = JSON.parse(lineJson) as {
      id?: number; user?: { login?: string }; author_association?: string;
      body?: string; path?: string; line?: number | null;
    }[];
    const comments: PrComment[] = [
      ...(view.reviews ?? []).filter((r) => (r.body ?? '') !== '')
        .map((r) => ({ author: r.author?.login ?? '', authorAssociation: r.authorAssociation ?? 'NONE', body: r.body ?? '' })),
      ...(view.comments ?? []).filter((c) => (c.body ?? '') !== '')
        .map((c) => ({ author: c.author?.login ?? '', authorAssociation: c.authorAssociation ?? 'NONE', body: c.body ?? '' })),
      ...lineComments.filter((c) => (c.body ?? '') !== '').map((c) => ({
        ...(c.id !== undefined ? { id: c.id } : {}),
        author: c.user?.login ?? '',
        authorAssociation: c.author_association ?? 'NONE',
        body: c.body ?? '',
        ...(c.path !== undefined ? { path: c.path } : {}),
        ...(c.line != null ? { line: c.line } : {}),
      })),
    ];
    const labels = (view.labels ?? []).map((label) => label.name ?? '').filter((name) => name !== '');
    return { headRefName: view.headRefName, title: view.title, labels, comments };
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

  const attempt = async (event: ReviewSubmission['event'], comments: ReviewInlineComment[]) => {
    const dir = await mkdtemp(join(tmpdir(), 'cycgraph-review-'));
    const payloadAt = join(dir, 'review.json');
    try {
      await writeFile(payloadAt, JSON.stringify({
        event,
        body: review.body,
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
  const degradations: string[] = [];
  for (let tries = 0; tries < 3; tries += 1) {
    try {
      await attempt(event, comments);
      return {
        ok: true,
        event,
        inlineCount: comments.length,
        detail: `submitted ${event} review with ${comments.length} inline comment(s)`
          + (degradations.length > 0 ? ` (${degradations.join('; ')})` : ''),
      };
    } catch (error) {
      const message = (error as Error).message;
      // A token reviewing its own PR may neither approve nor request
      // changes; the verdict then rides the body of a COMMENT review.
      if (event !== 'COMMENT' && /your own pull request/i.test(message)) {
        degradations.push(`${event} refused on own PR, submitted as COMMENT`);
        event = 'COMMENT';
        continue;
      }
      if (comments.length > 0) {
        degradations.push('inline comments rejected, kept in the body');
        comments = [];
        continue;
      }
      return { ok: false, detail: `review not submitted: ${message.split('\n')[0] ?? 'gh api failed'}` };
    }
  }
  return { ok: false, detail: 'review not submitted after degrading every optional part' };
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
    return { ok: false, detail: (error as Error).message.split('\n')[0] ?? 'comment failed' };
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
    return { ok: false, detail: (error as Error).message.split('\n')[0] ?? 'reply failed' };
  }
}

/** One review-comment thread on a pull request, as resolution needs it. */
export interface ReviewThread {
  /** GraphQL node id, the handle `resolveReviewThread` takes. */
  id: string;
  isResolved: boolean;
  path?: string;
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
      + 'reviewThreads(first:100){nodes{id isResolved path '
      + 'comments(first:1){nodes{body databaseId viewerDidAuthor createdAt pullRequestReview{id}}}}}}}}';
    const { stdout } = await exec('gh', [
      'api', 'graphql',
      '-f', `query=${query}`,
      '-f', `owner=${slug.owner}`, '-f', `name=${slug.name}`, '-F', `pr=${prNumber}`,
    ], { cwd: repoRoot, ...(env !== undefined ? { env } : {}) });
    const parsed = JSON.parse(stdout) as {
      data?: { repository?: { pullRequest?: { reviewThreads?: { nodes?: {
        id?: string; isResolved?: boolean; path?: string | null;
        comments?: { nodes?: {
          body?: string; databaseId?: number; viewerDidAuthor?: boolean;
          createdAt?: string; pullRequestReview?: { id?: string } | null;
        }[] };
      }[] } } } };
    };
    const nodes = parsed.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
    return nodes.flatMap((node) => {
      if (node.id === undefined) return [];
      const first = node.comments?.nodes?.[0];
      return [{
        id: node.id,
        isResolved: node.isResolved === true,
        ...(node.path != null ? { path: node.path } : {}),
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
    return { ok: false, detail: (error as Error).message.split('\n')[0] ?? 'resolve failed' };
  }
}
