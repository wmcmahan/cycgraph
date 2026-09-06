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
