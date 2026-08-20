/**
 * The workspace session: read-before-edit, enforced by the harness
 *
 * What a model reads and what it edits must be the same bytes, and that is
 * an invariant for the harness to hold, not the model to remember. The
 * session records a content hash at every read; the edit tool refuses a file
 * that was never read, and refuses one whose content changed since — the
 * agent is told to read again, never left editing from a stale picture.
 *
 * @module workspace/session
 */

import { createHash } from 'node:crypto';

/** Content hashes of files as last read, keyed by absolute path. */
export interface WorkspaceSession {
  readonly seen: Map<string, string>;
}

/** A fresh session, shared across one workspace's tool set. */
export function createWorkspaceSession(): WorkspaceSession {
  return { seen: new Map() };
}

/** The fingerprint the session stores and compares. */
export function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}
