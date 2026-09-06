/**
 * GitHub issues as a workflow's ledger.
 *
 * A maintenance workflow files what it senses as issues and must never
 * file the same finding twice, so the two operations here are listing
 * open issues (to read the dedupe markers out of their bodies) and
 * creating one. Both go through `gh`; when it cannot answer — missing,
 * unauthenticated, no remote — the result says so rather than
 * pretending an empty ledger, because filing blind is how duplicates
 * happen.
 *
 * @module git/issues
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/** An open issue, as much of it as dedupe needs. */
export interface IssueRef {
  number: number;
  title: string;
  body: string;
}

function ghEnv(token?: string): NodeJS.ProcessEnv | undefined {
  return token !== undefined ? { ...process.env, GH_TOKEN: token } : undefined;
}

/**
 * Open issues on the repository's remote. `undefined` when the list
 * cannot be read — treat that as "cannot see", never as "none".
 */
export async function listOpenIssues(
  repoRoot: string,
  options: { token?: string; label?: string } = {},
): Promise<IssueRef[] | undefined> {
  try {
    const { stdout } = await exec(
      'gh', [
        'issue', 'list', '--state', 'open', '--limit', '200', '--json', 'number,title,body',
        ...(options.label !== undefined ? ['--label', options.label] : []),
      ],
      { cwd: repoRoot, ...(ghEnv(options.token) !== undefined ? { env: ghEnv(options.token) } : {}) },
    );
    return JSON.parse(stdout) as IssueRef[];
  } catch {
    return undefined;
  }
}

/** Create one issue; the URL on success, the failure's message otherwise. */
export async function createIssue(
  repoRoot: string,
  issue: { title: string; body: string },
  options: { token?: string } = {},
): Promise<{ url: string } | { error: string }> {
  try {
    const { stdout } = await exec(
      'gh', ['issue', 'create', '--title', issue.title, '--body', issue.body],
      { cwd: repoRoot, ...(ghEnv(options.token) !== undefined ? { env: ghEnv(options.token) } : {}) },
    );
    return { url: stdout.trim().split('\n').pop() ?? '' };
  } catch (error) {
    return { error: (error as Error).message.trim() };
  }
}

const MARKER = /<!--\s*cycgraph:finding=([^\s>]+)\s*-->/g;

/** Render the marker `issueMarkers` recovers, for an issue body. */
export function findingMarker(key: string): string {
  return `<!-- cycgraph:finding=${key} -->`;
}

/** Every finding key marked in the given issue bodies. */
export function issueMarkers(issues: readonly IssueRef[]): Set<string> {
  const keys = new Set<string>();
  for (const issue of issues) {
    for (const match of issue.body.matchAll(MARKER)) keys.add(match[1]!);
  }
  return keys;
}
