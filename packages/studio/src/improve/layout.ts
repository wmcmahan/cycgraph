/**
 * Where a workflow's code sits inside a workspace clone
 *
 * The studio edits whatever file a host's `cycgraph.config` declares, and
 * that path is arbitrary: the verification that follows an edit has to
 * re-import and typecheck THAT file's project, not this repository's own
 * internal dev package. These resolvers turn a known source path into the
 * module to import and the directory to typecheck, and fall back to the
 * `packages/playground` convention only when no source path is known.
 *
 * @module improve/layout
 */

import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

/** This repository's own internal dev package, relative to a repo root. */
const PLAYGROUND = join('packages', 'playground');

/**
 * A workflow's source file as an absolute path inside the clone.
 *
 * Accepts a path relative to `root` or an absolute path already under it.
 * Anything resolving outside the clone — a host checkout's absolute path,
 * which means nothing here — yields undefined, so callers fall back.
 */
export function sourceInWorkspace(root: string, sourcePath?: string): string | undefined {
  if (!sourcePath) return undefined;
  const base = resolve(root);
  const abs = isAbsolute(sourcePath) ? sourcePath : resolve(base, sourcePath);
  const inside = relative(base, abs);
  return inside.length > 0 && !inside.startsWith('..') ? abs : undefined;
}

/**
 * A host checkout's source path as it sits inside a clone of that checkout.
 *
 * The path a host's `cycgraph.config` declares is absolute in the ORIGINAL
 * checkout, where it means nothing to a clone; a clone mirrors the tracked
 * layout, so the same repo-relative path locates the file in the workspace.
 * Returns that relative path, or undefined when the file lies outside
 * `repoRoot` and no rebase can place it.
 */
export function rebaseSource(repoRoot: string, sourcePath?: string): string | undefined {
  if (!sourcePath) return undefined;
  const inside = relative(resolve(repoRoot), resolve(sourcePath));
  return inside.length > 0 && !inside.startsWith('..') && !isAbsolute(inside) ? inside : undefined;
}

/** The scenario module a post-edit rebuild imports from the clone. */
export function scenarioModulePath(root: string, workflow: string, sourcePath?: string): string {
  return sourceInWorkspace(root, sourcePath)
    ?? join(root, PLAYGROUND, 'src', 'scenarios', workflow, 'scenario.ts');
}

/**
 * The directory `tsc --noEmit` runs in for an edited workflow.
 *
 * The nearest ancestor of the edited file that holds a `tsconfig.json`,
 * bounded by the clone root: that is the TypeScript project the edit
 * belongs to, and the one whose errors are the edit's own.
 */
export function typecheckDir(root: string, sourcePath?: string): string {
  const abs = sourceInWorkspace(root, sourcePath);
  if (!abs) return join(root, PLAYGROUND);
  const base = resolve(root);
  const from = dirname(abs);
  for (let dir = from; ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'tsconfig.json'))) return dir;
    if (dir === base || dirname(dir) === dir) return from;
  }
}
