/**
 * The workspace jail
 *
 * Every workspace tool resolves paths through this, and nothing a caller
 * writes in a path argument can escape the root: not `..`, not an absolute
 * path, not a mix, and not a symlink planted inside the root that points
 * out of it. The jail throwing is the tool refusing — the error text is
 * the tool result an agent reads and reacts to.
 *
 * @module workspace/jail
 */

import { realpathSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';

/** A path argument that tried to leave the workspace. */
export class WorkspaceEscapeError extends Error {
  constructor(path: string) {
    super(`path '${path}' escapes the workspace`);
    this.name = 'WorkspaceEscapeError';
  }
}

/**
 * The real path of `path`, or of its deepest ancestor that exists.
 *
 * A file the caller is about to create has no real path of its own, so
 * confinement is decided by the directory it would land in — walking up
 * only as far as the filesystem actually goes.
 */
function realAncestor(path: string): string {
  let current = path;
  for (;;) {
    try {
      return realpathSync(current);
    } catch {
      const parent = dirname(current);
      if (parent === current) return current;
      current = parent;
    }
  }
}

/** Whether `candidate` is the root itself or lies beneath it. */
function within(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + sep);
}

/**
 * Resolve a caller path against the root, refusing anything outside it.
 *
 * Two checks, because either alone is a hole. The lexical one rejects `..`
 * and absolute paths. The real one rejects paths whose target leaves the
 * root through a symlink inside it — a workspace clone may well carry such
 * links (a linked `node_modules` is the usual one), and `writeFile` follows
 * them straight into whatever tree they point at.
 *
 * @param root - The workspace root every path is confined to.
 * @param path - The caller's path, relative to `root` or absolute.
 * @returns The absolute path under `root`, unresolved, so callers see the
 *   workspace-shaped path they asked for.
 * @throws {WorkspaceEscapeError} If the path escapes `root` lexically or
 *   through a symlink.
 */
export function jailedPath(root: string, path: string): string {
  const abs = resolve(root, path);
  const rel = relative(root, abs);
  if (rel.startsWith('..') || rel.split(sep)[0] === '..') {
    throw new WorkspaceEscapeError(path);
  }
  if (!within(realAncestor(root), realAncestor(abs))) {
    throw new WorkspaceEscapeError(path);
  }
  return abs;
}
