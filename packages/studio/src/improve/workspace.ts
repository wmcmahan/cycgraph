/**
 * Workspace lifecycle: the deterministic shell around a code edit
 *
 * A workspace is a disposable local clone of the repository on its own
 * branch. The editor agent works only inside it, through the workspace MCP
 * server; this module owns everything that is not intelligence — cloning,
 * branching, verifying, committing, and preparing the pull request — because
 * git and build tools are procedures, and procedures do not belong to a
 * model.
 *
 * Nothing here touches the caller's working tree, branches, or remotes. The
 * clone is local (`git clone` from the repo path), the branch exists in the
 * clone, and the prepared `gh pr create` command is printed for a person to
 * run — pushing is a decision, not a step.
 *
 * @module improve/workspace
 */

import { execFile } from 'node:child_process';
import { appendFile, mkdtemp, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import type { Change } from '@cycgraph/orchestrator';
import { verifyBuilt } from './editor.js';
import type { ProposalRecord } from './proposals.js';
import type { Scenario } from '../scenarios/types.js';
import type { Stack } from '../stack/index.js';

const exec = promisify(execFile);

/** A disposable clone on its own branch. */
export interface Workspace {
  /** Absolute path of the clone. */
  root: string;
  /** The branch the edit lands on. */
  branch: string;
}

/** The branch name a proposal's edit lands on. */
export function branchNameFor(record: ProposalRecord): string {
  return `tune/${record.id.replace(/[^a-zA-Z0-9._-]+/g, '-')}`;
}

/**
 * Clone the repository into a temp directory and branch it.
 *
 * A full local clone rather than a worktree, so nothing the editor or the
 * verification does can reach back into the caller's checkout through shared
 * git state.
 *
 * `options.at` pins the clone's path instead of minting one. That is what
 * lets a graph bind its workspace tools to a root at build time and
 * materialize the clone at that root mid-run, once a gate has approved the
 * edit.
 */
export async function createWorkspace(
  repoRoot: string,
  record: ProposalRecord,
  options: { at?: string } = {},
): Promise<Workspace> {
  const root = options.at ?? await mkdtemp(join(tmpdir(), 'cycgraph-ws-'));
  await exec('git', ['clone', '--quiet', '--no-hardlinks', repoRoot, root]);
  const branch = branchNameFor(record);
  await exec('git', ['checkout', '--quiet', '-b', branch], { cwd: root });

  // A clone carries only tracked files, and verification needs to import and
  // typecheck — so the source repo's dependency tree is linked in, read-only
  // by convention. Engine code resolves from the link; the code under edit
  // is the clone's own.
  const modules = join(repoRoot, 'node_modules');
  if (existsSync(modules) && !existsSync(join(root, 'node_modules'))) {
    await symlink(modules, join(root, 'node_modules'));
    // The link is scaffolding, not a change: excluded clone-locally so no
    // `git add -A` can ever commit it.
    await appendFile(join(root, '.git', 'info', 'exclude'), 'node_modules\n');
  }
  return { root, branch };
}

/** Paths and files the editor changed, per git. */
export async function changedFiles(ws: Workspace): Promise<string[]> {
  const { stdout } = await exec('git', ['status', '--porcelain'], { cwd: ws.root });
  return stdout.split('\n').filter(Boolean).map(line => line.slice(3));
}

/** The committed edit as a patch, for the report and the PR body. */
export async function workspaceDiff(ws: Workspace): Promise<string> {
  const { stdout } = await exec('git', ['show', '--format=', '--patch', 'HEAD'], { cwd: ws.root });
  return stdout;
}

/**
 * The mechanical verdict on the workspace's edit.
 *
 * Two gates, both blind to how the edit looks. The scenario module is
 * imported fresh **from the clone** and rebuilt: the built workflow must
 * carry exactly the proposed values. Then the clone's playground package
 * typechecks, so an edit that satisfies the value but breaks the code is
 * caught before anyone reviews it.
 */
export async function verifyWorkspace(
  ws: Workspace,
  stack: Stack,
  workflow: string,
  changes: readonly Change[],
): Promise<string | undefined> {
  const scenarioPath = join(ws.root, 'packages', 'playground', 'src', 'scenarios', workflow, 'scenario.ts');
  try {
    const mod = await import(`${pathToFileURL(scenarioPath).href}?ws=${Date.now()}`) as { default: Scenario };
    const mismatch = await verifyBuilt(mod.default, stack, changes);
    if (mismatch) return mismatch;
  } catch (err) {
    return `the edited workspace does not build: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`;
  }

  try {
    await exec('npx', ['tsc', '--noEmit'], { cwd: join(ws.root, 'packages', 'playground') });
  } catch (err) {
    const detail = err instanceof Error && 'stdout' in err ? String((err as { stdout: unknown }).stdout) : String(err);
    return `the workspace fails typecheck: ${detail.split('\n').filter(Boolean).slice(0, 3).join(' | ')}`;
  }

  return undefined;
}

/** Commit the edit with the proposal's evidence as the message. */
export async function commitWorkspace(ws: Workspace, record: ProposalRecord): Promise<void> {
  const message = [
    `tune: ${record.nodeId}.${record.knob} ${String(record.from)} → ${String(record.to)} (${record.workflow})`,
    '',
    `Measured: ${Math.round(record.computeDelta * 100)}% execution time, ${Math.round(record.tokenDelta * 100)}% tokens, on ${record.model}.`,
    `Base runs: ${record.measuredOn.join(', ')}.`,
    ...(record.validation ? [`Held-out: ${record.validation.detail}.`] : []),
    '',
    `Proposal: ${record.id}`,
  ].join('\n');
  await exec('git', ['add', '-A'], { cwd: ws.root });
  // Explicit identity: the commit is the loop's, and a server has no global
  // git config to fall back on.
  await exec('git', [
    '-c', 'user.name=cycgraph-tune', '-c', 'user.email=tune@cycgraph.local',
    'commit', '--quiet', '-m', message,
  ], { cwd: ws.root });
}

/**
 * The pull-request script, prepared and shown rather than run.
 *
 * Pushing a branch and opening a PR publish to the world, and that is the
 * person's step by design: the workspace holds the commit, and this is the
 * exact sequence that ships it. Two steps, because the clone's `origin` is
 * the LOCAL repository it was cloned from: the first push is a local
 * handoff landing the branch in that repository's refs, and only from
 * there — where `origin` points at the real remote — can the branch be
 * published and the PR opened.
 */
export function prCommand(ws: Workspace, record: ProposalRecord, repoRoot: string): string {
  const title = `tune: ${record.nodeId}.${record.knob} ${String(record.from)} → ${String(record.to)}`;
  const body = `Measured by the tuning loop: proposal ${record.id}. Evidence in the ledger.`;
  return [
    `git -C ${ws.root} push origin ${ws.branch}`,
    `# that push lands the branch in ${repoRoot}; publish it from there:`,
    `cd ${repoRoot}`,
    `git push -u origin ${ws.branch}`,
    `gh pr create --title ${JSON.stringify(title)} --body ${JSON.stringify(body)}`,
  ].join('\n');
}
