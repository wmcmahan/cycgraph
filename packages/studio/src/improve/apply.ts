/**
 * Applying a proposal: one flow, every front end
 *
 * The clone → edit → verify → commit → prepare sequence, extracted so the
 * CLI and the dashboard drive the identical path. The one decision made
 * here rather than by the caller is WHICH repository to clone: the real one
 * when it tracks the target's source, a freshly built fixture when the
 * source is gitignored. A host that wants no detection sets `repo` in its
 * studio config; `config.applyRepo` bypasses this entirely.
 *
 * Publishing stays outside: the outcome carries the prepared PR script and
 * the committed diff, and running the script is the person's step.
 *
 * @module improve/apply
 */

import { execFile } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { editInWorkspace } from './editor.js';
import { refreshFixtureRepo } from './fixture.js';
import { existsSync } from 'node:fs';
import { setProposalStatus } from './proposals.js';
import type { ProposalRecord } from './proposals.js';
import {
  changedFiles,
  commitWorkspace,
  createWorkspace,
  prCommand,
  verifyWorkspace,
  workspaceDiff,
} from './workspace.js';
import type { Stack } from '../stack/index.js';

const exec = promisify(execFile);

/** What an apply produced, beyond the ledger transition it wrote. */
export interface ApplyProposalOutcome {
  record: ProposalRecord;
  workspace: string;
  branch: string;
  files: string[];
  diff: string;
  prCommand: string;
  /** The repository the workspace was cloned from. */
  repoRoot: string;
  /** True when that repository is a throwaway fixture. */
  fixture: boolean;
}

/**
 * The repository an apply should clone.
 *
 * The real repository wins when it tracks the target's source; an
 * untracked target gets a fixture built from the current tree instead,
 * because a clone of the real repo would not contain the file the editor
 * must edit. When the catalog knows the target's source path the check is
 * that file exactly; without one it falls back to asking whether the
 * playground is tracked, the old whole-harness sentinel.
 */
export async function resolveApplyRepo(
  repoRoot: string,
  playgroundRoot: string,
  sourcePath?: string,
): Promise<{ root: string; fixture: boolean }> {
  const real = resolve(repoRoot);
  const sentinel = sourcePath !== undefined && !relative(real, sourcePath).startsWith('..')
    ? relative(real, sourcePath)
    : 'packages/playground/src';
  const { stdout } = await exec(
    'git', ['-C', real, 'ls-files', sentinel],
  ).catch(() => ({ stdout: '' }));
  if (stdout.trim().length > 0) return { root: real, fixture: false };

  const at = await mkdtemp(join(tmpdir(), 'cycgraph-apply-fixture-'));
  return { root: await refreshFixtureRepo(at, playgroundRoot), fixture: true };
}

/**
 * Apply one proposal: clone, edit, verify, commit, stamp `pr`.
 *
 * Throws on any failure — an editor that changed nothing, a rebuild that
 * does not carry the proposed value, a broken typecheck — and leaves the
 * ledger where it was, so the standalone commands can pick the proposal up
 * again.
 */
export async function applyProposal(
  stack: Stack,
  repoRoot: string,
  record: ProposalRecord,
  say: (message: string) => void = () => {},
  /** Where this workflow is defined, when the catalog knows. */
  sourcePath?: string,
): Promise<ApplyProposalOutcome> {
  if (record.status === 'pr' || record.status === 'applied') {
    throw new Error(`${record.id} is already ${record.status}`);
  }

  say('cloning into a workspace…');
  const ws = await createWorkspace(repoRoot, record);
  say(`${ws.root} on ${ws.branch}`);

  say(`editing: ${record.nodeId}.${record.knob} ${String(record.from)} → ${String(record.to)}`);
  // A tail is a draw: an editor session that produced nothing gets one
  // fresh attempt before the pass is declared failed.
  let files: string[] = [];
  for (let attempt = 0; attempt < 2 && files.length === 0; attempt++) {
    // An absolute host path means nothing inside a clone, and a fixture
    // repository may not hold this file at all — so the hint is offered
    // only when it resolves to something the workspace actually has.
    const inWorkspace = sourcePath ? relative(repoRoot, sourcePath) : undefined;
    const hint = inWorkspace && !inWorkspace.startsWith('..') && existsSync(join(ws.root, inWorkspace))
      ? inWorkspace
      : undefined;
    if (sourcePath && !hint) say('the declared source file is not in this repository — searching for it instead');

    const report = await editInWorkspace(stack, ws.root, record, hint);
    say(`editor: ${report.split('\n')[0]}`);
    files = await changedFiles(ws);
  }
  if (files.length === 0) {
    throw new Error('the editor changed nothing in two attempts — no branch was made');
  }
  say(`changed: ${files.join(', ')}`);

  const failure = await verifyWorkspace(ws, stack, record.workflow, record.change);
  if (failure) throw new Error(`verification failed: ${failure}`);
  say('verified: rebuild carries the proposed values; typecheck clean');

  await commitWorkspace(ws, record);
  const diff = await workspaceDiff(ws);
  const command = prCommand(ws, record, repoRoot);
  const result = await setProposalStatus(stack.config.artifactRoot, record.id, 'pr', {
    branch: ws.branch,
    workspace: ws.root,
    prCommand: command,
    diff,
  });
  if ('error' in result) throw new Error(result.error);
  say(`${record.id} → pr`);

  return {
    record: result.record,
    workspace: ws.root,
    branch: ws.branch,
    files,
    diff,
    prCommand: command,
    repoRoot,
    fixture: false,
  };
}
