/**
 * The fixture repository: an editable stand-in for this repo
 *
 * The playground is gitignored, so a clone of the real repository does not
 * contain the scenario sources the editor needs to edit. The fixture is the
 * workaround: a throwaway git repository holding a current copy of the
 * playground package under the real repo's layout, with `node_modules`
 * symlinked to the real tree so typecheck and rebuild-compare resolve their
 * dependencies. Everything git here happens inside the fixture — never the
 * caller's repository.
 *
 * @module improve/fixture
 */

import { execFile } from 'node:child_process';
import { cp, mkdir, rm, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/** Entries copied into the fixture's playground package. */
const PLAYGROUND_ENTRIES = ['src', 'package.json', 'tsconfig.json'];

/**
 * Rebuild the fixture repository from the current playground tree.
 *
 * @param at - Directory the fixture is (re)created in. Destroyed first.
 * @param playgroundRoot - The real `packages/playground` directory.
 * @returns The fixture's root path, usable as `--repo` / `repoRoot`.
 */
export async function refreshFixtureRepo(at: string, playgroundRoot: string): Promise<string> {
  const root = resolve(at);
  await rm(root, { recursive: true, force: true });
  const packageDir = join(root, 'packages', 'playground');
  await mkdir(packageDir, { recursive: true });

  for (const entry of PLAYGROUND_ENTRIES) {
    await cp(join(playgroundRoot, entry), join(packageDir, entry), { recursive: true });
  }

  // The real dependency tree, linked rather than installed: the clone-side
  // exclude in `createWorkspace` keeps the link out of any commit.
  const modules = join(resolve(playgroundRoot, '..', '..'), 'node_modules');
  await symlink(modules, join(root, 'node_modules'));

  const git = (...args: string[]) => exec('git', args, { cwd: root });
  await git('init', '--quiet');
  await git('add', 'packages');
  await git(
    '-c', 'user.name=cycgraph-fixture',
    '-c', 'user.email=fixture@cycgraph.local',
    'commit', '--quiet', '-m', 'fixture',
  );
  return root;
}
