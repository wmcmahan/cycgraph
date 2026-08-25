/**
 * Deliver a change on a branch, for any workflow that writes to a
 * repository.
 *
 * The improve ladder's workspace helpers do this already, but shaped
 * around a proposal record: their branch names, commit messages, and PR
 * bodies all describe a measured knob change. A maintenance workflow
 * writes for different reasons, so the mechanics live here and the
 * wording is the caller's.
 *
 * The boundary is the same one the rest of the studio holds: clone,
 * edit, commit, and stop. Pushing publishes, and publishing is a
 * person's decision.
 *
 * @module maintenance/branch
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, mkdtemp, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/** A disposable clone on its own branch. */
export interface Branch {
  root: string;
  branch: string;
}

/** Clone `repoRoot` to a workspace and check out `branch`. */
export async function cloneToBranch(
  repoRoot: string,
  branch: string,
  options: { at?: string } = {},
): Promise<Branch> {
  const root = options.at ?? await mkdtemp(join(tmpdir(), 'cycgraph-work-'));
  await exec('git', ['clone', '--quiet', '--no-hardlinks', repoRoot, root]);
  await exec('git', ['checkout', '--quiet', '-b', branch], { cwd: root });

  // A clone carries only tracked files, and checks need to resolve imports,
  // so the source repository's dependency tree is linked in. The link is
  // scaffolding rather than a change, and is excluded clone-locally so no
  // `git add -A` can commit it.
  const modules = join(repoRoot, 'node_modules');
  if (existsSync(modules) && !existsSync(join(root, 'node_modules'))) {
    await symlink(modules, join(root, 'node_modules'));
    await appendFile(join(root, '.git', 'info', 'exclude'), 'node_modules\n');
  }
  return { root, branch };
}

/** Files the workspace changed, per git. */
export async function changedIn(root: string): Promise<string[]> {
  const { stdout } = await exec('git', ['status', '--porcelain'], { cwd: root });
  return stdout.split('\n').filter(Boolean).map((line) => line.slice(3));
}

/** The uncommitted change as a patch. */
export async function pendingDiff(root: string): Promise<string> {
  const { stdout } = await exec('git', ['diff'], { cwd: root });
  return stdout;
}

/** Commit everything in the workspace under an explicit identity. */
export async function commit(root: string, message: string): Promise<void> {
  await exec('git', ['add', '-A'], { cwd: root });
  // A server has no global git config to fall back on, and the commit is
  // the studio's rather than whoever started it.
  await exec('git', [
    '-c', 'user.name=cycgraph-studio', '-c', 'user.email=studio@cycgraph.local',
    'commit', '--quiet', '-m', message,
  ], { cwd: root });
}

/**
 * The publish sequence, prepared and printed rather than run.
 *
 * Two steps, because the clone's `origin` is the local repository it came
 * from: the first push hands the branch back to that repository, and only
 * from there — where `origin` is the real remote — can it be published.
 */
export function publishScript(
  ws: Branch,
  repoRoot: string,
  title: string,
  body: string,
): string {
  return [
    `git -C ${ws.root} push origin ${ws.branch}`,
    `# that push lands the branch in ${repoRoot}; publish it from there:`,
    `cd ${repoRoot}`,
    `git push -u origin ${ws.branch}`,
    `gh pr create --title ${JSON.stringify(title)} --body ${JSON.stringify(body)}`,
  ].join('\n');
}
