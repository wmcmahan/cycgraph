/**
 * GitHub issues as a workflow's ledger.
 *
 * A maintenance workflow files what it senses as issues and must never
 * file the same finding twice, so the operations here are listing open
 * issues (to read the dedupe markers out of their bodies), reading one
 * (to brief a reviewer on the intent a PR claims to serve), creating
 * one, commenting on one, and labeling one. All go through `gh`; when
 * it cannot answer — missing, unauthenticated, no remote — the result
 * says so rather than pretending an empty ledger, because filing blind
 * is how duplicates happen.
 *
 * @module git/issues
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ghErrorDetail } from './pr.js';

const exec = promisify(execFile);

/** An open issue, as much of it as dedupe and queue ordering need. */
export interface IssueRef {
  number: number;
  title: string;
  body: string;
  /** Label names, for priority ordering and approval checks. */
  labels: string[];
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
        'issue', 'list', '--state', 'open', '--limit', '200', '--json', 'number,title,body,labels',
        ...(options.label !== undefined ? ['--label', options.label] : []),
      ],
      { cwd: repoRoot, ...(ghEnv(options.token) !== undefined ? { env: ghEnv(options.token) } : {}) },
    );
    const rows = JSON.parse(stdout) as
      { number: number; title: string; body: string; labels?: { name?: string }[] }[];
    return rows.map((row) => ({
      number: row.number,
      title: row.title,
      body: row.body,
      labels: (row.labels ?? []).map((label) => label.name ?? '').filter((name) => name !== ''),
    }));
  } catch {
    return undefined;
  }
}

/**
 * Create one issue; the URL on success, the failure's message otherwise.
 * Labels are best-effort: each is created on the repository if missing,
 * and a label the token cannot attach never costs the ticket itself.
 */
export async function createIssue(
  repoRoot: string,
  issue: { title: string; body: string; labels?: string[] },
  options: { token?: string } = {},
): Promise<{ url: string } | { error: string }> {
  const env = ghEnv(options.token);
  const opts = { cwd: repoRoot, ...(env !== undefined ? { env } : {}) };
  const labels = issue.labels ?? [];
  // `--label` only attaches labels that already exist; creating one that
  // does exist fails, which is the ordinary case here.
  for (const label of labels) {
    await exec('gh', ['label', 'create', label], opts).catch(() => undefined);
  }
  const create = async (withLabels: boolean) => {
    const { stdout } = await exec('gh', [
      'issue', 'create', '--title', issue.title, '--body', issue.body,
      ...(withLabels ? labels.flatMap((label) => ['--label', label]) : []),
    ], opts);
    return { url: stdout.trim().split('\n').pop() ?? '' };
  };
  try {
    return await create(labels.length > 0);
  } catch (error) {
    if (labels.length > 0) {
      try {
        return await create(false);
      } catch {
        // The labeled attempt's error names the truer failure.
      }
    }
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

/**
 * One issue by number, open or closed. `undefined` when it cannot be
 * read — an absent issue and an unreadable ledger look the same to the
 * caller, and both mean "review without it", never "fail the run".
 */
export async function viewIssue(
  repoRoot: string,
  issueNumber: number,
  options: { token?: string } = {},
): Promise<{ title: string; body: string } | undefined> {
  const env = ghEnv(options.token);
  try {
    const { stdout } = await exec(
      'gh', ['issue', 'view', String(issueNumber), '--json', 'title,body'],
      { cwd: repoRoot, ...(env !== undefined ? { env } : {}) },
    );
    const view = JSON.parse(stdout) as { title?: string; body?: string };
    return { title: view.title ?? '', body: view.body ?? '' };
  } catch {
    return undefined;
  }
}

/** Comment on an issue; the failure's message when it cannot. */
export async function commentOnIssue(
  repoRoot: string,
  issueNumber: number,
  body: string,
  options: { token?: string } = {},
): Promise<{ ok: boolean; detail: string }> {
  const env = ghEnv(options.token);
  try {
    await exec('gh', ['issue', 'comment', String(issueNumber), '--body', body],
      { cwd: repoRoot, ...(env !== undefined ? { env } : {}) });
    return { ok: true, detail: 'commented' };
  } catch (error) {
    return { ok: false, detail: ghErrorDetail(error) };
  }
}

/** Add a label to an issue, creating it on the repository when missing. */
export async function addIssueLabel(
  repoRoot: string,
  issueNumber: number,
  label: string,
  options: { token?: string } = {},
): Promise<{ ok: boolean; detail: string }> {
  const env = ghEnv(options.token);
  const opts = { cwd: repoRoot, ...(env !== undefined ? { env } : {}) };
  await exec('gh', ['label', 'create', label], opts).catch(() => undefined);
  try {
    await exec('gh', ['issue', 'edit', String(issueNumber), '--add-label', label], opts);
    return { ok: true, detail: `labeled ${label}` };
  } catch (error) {
    return { ok: false, detail: ghErrorDetail(error) };
  }
}
