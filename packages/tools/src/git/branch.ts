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
import { appendFile, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import { DEFAULT_IDENTITY, type CommitIdentity, type PublishConfig } from './config.js';

const rawExec = promisify(execFile);

/**
 * How long any git or gh call here may run before it is killed. A
 * delivery step (clone, push, PR create) that hangs would otherwise wedge
 * a run with no bound; `execFile`'s own timeout SIGTERMs the child, which
 * the tool layer's `Promise.race` timeout cannot.
 */
const GIT_EXEC_TIMEOUT_MS = 300_000;

/** `execFile` with a hard timeout applied to every delivery call. */
const exec = (
  file: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; maxBuffer?: number; timeout?: number } = {},
): Promise<{ stdout: string; stderr: string }> =>
  rawExec(file, [...args], { timeout: GIT_EXEC_TIMEOUT_MS, ...options }) as Promise<{ stdout: string; stderr: string }>;

function assertSafeGitArg(value: string, name: string): void {
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.startsWith('-')) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
}

/**
 * Whether a ref name is safe to hand to git as a branch argument. A pull
 * request's head branch name is chosen by whoever pushed the branch, so it
 * is validated against git's ref-format rules before it reaches a fetch
 * refspec or a checkout: a name beginning with a dash would be read as an
 * option, and the metacharacters below could escape a refspec. Restricted
 * to an allowlist so an unforeseen ref shape fails closed.
 */
export function isSafeGitRef(ref: string): boolean {
  if (ref === '' || ref.length > 255) return false;
  // Reject control characters and space by code point.
  for (let i = 0; i < ref.length; i++) {
    const code = ref.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return false;
  }
  // The git ref metacharacters ~ ^ : ? * [ \ cannot appear in a branch name.
  if (/[~^:?*[\\]/.test(ref)) return false;
  if (ref.startsWith('-') || ref.startsWith('/') || ref.startsWith('.')) return false;
  if (ref.endsWith('/') || ref.endsWith('.') || ref.endsWith('.lock')) return false;
  return !(ref.includes('..') || ref.includes('//') || ref.includes('@{'));
}

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
  assertSafeGitArg(repoRoot, 'repoRoot');
  assertSafeGitArg(root, 'clone destination');
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

/**
 * Symlink every nested `node_modules` (two levels deep) into the clone,
 * then link every workspace package to the clone's own tree.
 *
 * The second pass closes the cross-package staleness hole: a dependent
 * resolving an internal package through the root `node_modules` symlink
 * reaches the CHECKOUT's build, so a clone-side edit to a dependency
 * could never be seen by its consumers' type checks — an unwinnable
 * gate for any cross-package fix. A scope link at each workspace group
 * level (`packages/node_modules/...`, `ops/node_modules/...`) sits
 * earlier on Node's resolution walk than the root symlink and points
 * every internal package at the clone itself, so consumers see what
 * the clone's own build produced.
 */
export async function linkNestedModules(repoRoot: string, root: string): Promise<void> {
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

  // A manifest name becomes path segments under node_modules below, and
  // the manifests are read from the CLONE — in pr-revise that is a PR
  // branch's content. npm's own name grammar (no leading dot, no
  // separators beyond the one scope slash) is what keeps a hostile
  // manifest from steering the symlink or removal outside the clone.
  const SAFE_PACKAGE_NAME = /^(?:@[a-z0-9~][a-z0-9._~-]*\/)?[a-z0-9~][a-z0-9._~-]*$/i;
  const clonePackages = new Map<string, string>();
  for (const entry of top) {
    const children = (await readdir(join(root, entry.name), { withFileTypes: true }).catch(() => []))
      .filter(isPlainDir);
    for (const child of children) {
      const cloneDir = join(root, entry.name, child.name);
      try {
        const manifest = JSON.parse(await readFile(join(cloneDir, 'package.json'), 'utf8')) as { name?: string };
        if (typeof manifest.name === 'string' && SAFE_PACKAGE_NAME.test(manifest.name)) clonePackages.set(manifest.name, cloneDir);
      } catch { /* no manifest here: not a package */ }
    }
  }
  // Every write below must land inside the clone. A directory pass one
  // linked to the checkout would silently forward a mkdir/symlink into
  // the source tree — and leave it dangling there once the clone is
  // removed — so any symlinked directory on the path is first replaced
  // by a real clone-local directory that re-links the target's entries.
  const materialize = async (dirPath: string): Promise<void> => {
    const stat = await lstat(dirPath).catch(() => undefined);
    if (stat === undefined || !stat.isSymbolicLink()) return;
    const target = await realpath(dirPath);
    await rm(dirPath);
    await mkdir(dirPath);
    for (const child of await readdir(target)) {
      await symlink(join(target, child), join(dirPath, child));
    }
  };
  const rootReal = await realpath(root);
  for (const entry of top) {
    const groupDir = join(root, entry.name);
    if (!existsSync(groupDir)) continue;
    await materialize(join(groupDir, 'node_modules'));
    for (const [name, dir] of clonePackages) {
      const linkPath = join(groupDir, 'node_modules', ...name.split('/'));
      await materialize(dirname(linkPath));
      const existing = await lstat(linkPath).catch(() => undefined);
      if (existing !== undefined) {
        // Never replace a real file or directory; a link already inside
        // the clone is this pass's own work from an earlier call.
        if (!existing.isSymbolicLink()) continue;
        const resolved = await realpath(linkPath).catch(() => undefined);
        if (resolved !== undefined && (resolved === rootReal || resolved.startsWith(rootReal + sep))) continue;
        await rm(linkPath);
      }
      await mkdir(dirname(linkPath), { recursive: true });
      await symlink(dir, linkPath);
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
  // belongs to the workflow rather than whoever started it. The
  // identity rides env as well as `-c`: GIT_AUTHOR_/GIT_COMMITTER_
  // vars in the ambient environment would override `-c user.*`.
  await exec('git', [
    '-c', `user.name=${identity.name}`, '-c', `user.email=${identity.email}`,
    'commit', '--quiet', '-m', message,
  ], {
    cwd: root,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: identity.name,
      GIT_AUTHOR_EMAIL: identity.email,
      GIT_COMMITTER_NAME: identity.name,
      GIT_COMMITTER_EMAIL: identity.email,
    },
  });
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
  const ghEnv = config.token !== undefined ? { env: { ...process.env, GH_TOKEN: config.token } } : {};
  const labels = config.labels ?? [];
  // Ensure each label exists (best-effort — an existing label or a
  // read-only token just fails and is ignored) so that creating the PR
  // already labeled cannot fail on a missing label. Creation and labeling
  // are then one atomic step: a crash can no longer leave a managed PR
  // without its label, invisible to the idle gate and the review loop.
  for (const label of labels) {
    try {
      await exec('gh', ['label', 'create', label], { cwd: repoRoot, ...ghEnv });
    } catch {
      // Already present, or the token cannot create it; the create below
      // still applies the label when it exists.
    }
  }
  try {
    const { stdout } = await exec(
      'gh',
      ['pr', 'create', '--head', ws.branch, '--title', title, '--body', body,
        ...labels.flatMap((label) => ['--label', label])],
      { cwd: repoRoot, ...ghEnv },
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
