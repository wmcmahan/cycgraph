/**
 * Deliver a change on a branch, for any workflow that writes to a
 * repository.
 *
 * These are caller-side procedures, never agent tools: the workspace
 * tools next door give a model read, search, and edit over a jailed
 * clone, while branching, committing, and publishing stay in the code
 * that drives it.
 *
 * The default boundary is clone, edit, commit, and stop. Pushing
 * publishes, so `publishScript` prepares the sequence for a person to
 * run; `publishBranch` runs it, for workflows whose operator has
 * decided publication is automatic.
 *
 * @module git/branch
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, mkdtemp, readdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';
import { DEFAULT_IDENTITY, type CommitIdentity, type PublishConfig } from './config.js';

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
    // The root link alone is not the whole tree: npm nests a package's
    // conflicting dependencies under its own node_modules, and code in
    // the clone resolving through the root symlink misses them.
    await linkNestedModules(repoRoot, root);
  }
  return { root, branch };
}

/** Symlink every nested `node_modules` (two levels deep) into the clone. */
async function linkNestedModules(repoRoot: string, root: string): Promise<void> {
  const isPlainDir = (entry: { isDirectory(): boolean; name: string }) =>
    entry.isDirectory() && entry.name !== 'node_modules' && !entry.name.startsWith('.');
  const top = (await readdir(repoRoot, { withFileTypes: true }).catch(() => [])).filter(isPlainDir);
  for (const entry of top) {
    const level1 = join(repoRoot, entry.name);
    const nested = (await readdir(level1, { withFileTypes: true }).catch(() => []))
      .filter(isPlainDir)
      .map((child) => join(level1, child.name));
    for (const dir of [level1, ...nested]) {
      const source = join(dir, 'node_modules');
      const inClone = join(root, relative(repoRoot, dir));
      if (existsSync(source) && existsSync(inClone) && !existsSync(join(inClone, 'node_modules'))) {
        await symlink(source, join(inClone, 'node_modules'));
      }
    }
  }
}

/** Files the workspace changed, per git. */
export async function changedIn(root: string): Promise<string[]> {
  const { stdout } = await exec('git', ['status', '--porcelain'], { cwd: root });
  return stdout.split('\n').filter(Boolean).map((line) => line.slice(3));
}

/** The uncommitted change as a patch. */
export async function pendingDiff(root: string): Promise<string> {
  // Intent-to-add first: a file the agent created is untracked, and a
  // bare `git diff` omits it entirely — reviewers and judges would see
  // imports of a file that "does not exist". commit() stages everything
  // anyway, so registering the path early changes nothing downstream.
  await exec('git', ['add', '--intent-to-add', '--all'], { cwd: root });
  const { stdout } = await exec('git', ['diff'], { cwd: root });
  return stdout;
}

/** The combined patch of the branch's last `commits` commits. */
export async function branchDiff(root: string, commits: number): Promise<string> {
  const { stdout } = await exec('git', ['diff', `HEAD~${commits}`, 'HEAD'], { cwd: root });
  return stdout;
}

/** Commit everything in the workspace under an explicit identity. */
export async function commit(
  root: string,
  message: string,
  identity: CommitIdentity = DEFAULT_IDENTITY,
): Promise<void> {
  await exec('git', ['add', '-A'], { cwd: root });
  // A server has no global git config to fall back on, and the commit
  // belongs to the workflow rather than whoever started it.
  await exec('git', [
    '-c', `user.name=${identity.name}`, '-c', `user.email=${identity.email}`,
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
  // The body goes through a quoted heredoc rather than an argument:
  // template-shaped bodies span many lines, and shell double-quoting
  // would deliver their newlines as literal backslash-n.
  return [
    `git -C ${ws.root} push origin ${ws.branch}`,
    `# that push lands the branch in ${repoRoot}; publish it from there:`,
    `cd ${repoRoot}`,
    `git push -u origin ${ws.branch}`,
    `gh pr create --title ${JSON.stringify(title)} --body-file - <<'PR_BODY'`,
    body,
    'PR_BODY',
  ].join('\n');
}

/** What `publishBranch` accomplished. */
export interface Published {
  pushed: boolean;
  /** URL of the created pull request, when `gh` was available. */
  prUrl?: string;
  /** Pre-filled create-a-PR page, when the push landed but `gh` is not installed. */
  openUrl?: string;
  detail: string;
}

/** The web URL of a git remote, from either its SSH or HTTPS form. */
function remoteWebUrl(remote: string): string | undefined {
  const m = remote.match(/^git@([^:]+):(.+?)(?:\.git)?$/)
    ?? remote.match(/^https:\/\/([^/]+)\/(.+?)(?:\.git)?$/);
  return m ? `https://${m[1]}/${m[2]}` : undefined;
}

/**
 * Push the workspace branch back through the source repository to its
 * real remote, for updating a branch that already has a pull request.
 * Two pushes because the clone's `origin` is the local repository it
 * came from: the branch is handed back there first, then published from
 * where `origin` is the real remote. Failures throw.
 */
export async function pushBranch(ws: Branch, repoRoot: string): Promise<void> {
  await exec('git', ['push', 'origin', ws.branch], { cwd: ws.root });
  await exec('git', ['push', '-u', 'origin', ws.branch], { cwd: repoRoot });
}

/**
 * Run the publish sequence `publishScript` prepares: `pushBranch`, then
 * a pull request opened with `gh`. When `gh` fails for any reason,
 * missing binary or missing auth alike, the pushed branch is not undone:
 * the result instead carries the pre-filled create-PR page as `openUrl`
 * and the failure's message in `detail`, so a caller can surface what a
 * person still has to do. Push failures do throw.
 */
export async function publishBranch(
  ws: Branch,
  repoRoot: string,
  title: string,
  body: string,
  config: PublishConfig = {},
): Promise<Published> {
  await pushBranch(ws, repoRoot);
  try {
    const { stdout } = await exec(
      'gh',
      ['pr', 'create', '--head', ws.branch, '--title', title, '--body', body],
      {
        cwd: repoRoot,
        ...(config.token !== undefined ? { env: { ...process.env, GH_TOKEN: config.token } } : {}),
      },
    );
    const prUrl = stdout.trim().split('\n').pop() ?? '';
    return { pushed: true, prUrl, detail: `opened ${prUrl}` };
  } catch (error) {
    const reason = (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? 'gh is not installed'
      : `gh pr create failed: ${(error as Error).message.trim()}`;
    const { stdout } = await exec('git', ['remote', 'get-url', 'origin'], { cwd: repoRoot });
    const web = remoteWebUrl(stdout.trim());
    return {
      pushed: true,
      ...(web ? { openUrl: `${web}/pull/new/${ws.branch}` } : {}),
      detail: `branch pushed; ${reason}; open the pull request from openUrl`,
    };
  }
}
