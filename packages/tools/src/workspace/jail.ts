/**
 * The workspace jail
 *
 * Every workspace tool resolves paths through this, and nothing a caller
 * writes in a path argument can escape the root: not `..`, not an absolute
 * path, not a mix. The jail throwing is the tool refusing — the error text is
 * the tool result an agent reads and reacts to.
 *
 * @module workspace/jail
 */

import { relative, resolve, sep } from 'node:path';

/** A path argument that tried to leave the workspace. */
export class WorkspaceEscapeError extends Error {
  constructor(path: string) {
    super(`path '${path}' escapes the workspace`);
    this.name = 'WorkspaceEscapeError';
  }
}

/** Resolve a caller path against the root, refusing anything outside it. */
export function jailedPath(root: string, path: string): string {
  const abs = resolve(root, path);
  const rel = relative(root, abs);
  if (rel.startsWith('..') || rel.split(sep)[0] === '..') {
    throw new WorkspaceEscapeError(path);
  }
  return abs;
}
