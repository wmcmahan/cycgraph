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
  author: string;
  body: string;
  /** File and line, for review comments anchored to the diff. */
  path?: string;
  line?: number;
}

/** A pull request's head branch and the human feedback on it. */
export interface PrFeedback {
  headRefName: string;
  title: string;
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
      'gh', ['pr', 'view', String(prNumber), '--json', 'headRefName,title,reviews,comments'], opts);
    const view = JSON.parse(stdout) as {
      headRefName: string; title: string;
      reviews?: { author?: { login?: string }; body?: string }[];
      comments?: { author?: { login?: string }; body?: string }[];
    };
    const { stdout: lineJson } = await exec(
      'gh', ['api', `repos/{owner}/{repo}/pulls/${prNumber}/comments`], opts);
    const lineComments = JSON.parse(lineJson) as
      { user?: { login?: string }; body?: string; path?: string; line?: number | null }[];
    const comments: PrComment[] = [
      ...(view.reviews ?? []).filter((r) => (r.body ?? '') !== '')
        .map((r) => ({ author: r.author?.login ?? '', body: r.body ?? '' })),
      ...(view.comments ?? []).filter((c) => (c.body ?? '') !== '')
        .map((c) => ({ author: c.author?.login ?? '', body: c.body ?? '' })),
      ...lineComments.filter((c) => (c.body ?? '') !== '').map((c) => ({
        author: c.user?.login ?? '',
        body: c.body ?? '',
        ...(c.path !== undefined ? { path: c.path } : {}),
        ...(c.line != null ? { line: c.line } : {}),
      })),
    ];
    return { headRefName: view.headRefName, title: view.title, comments };
  } catch {
    return undefined;
  }
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
