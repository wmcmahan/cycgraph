/**
 * Golden Dataset Paths
 *
 * Resolves manifest `file` fields to absolute paths confined to the golden
 * directory. Kept free of SQLite imports so path checks cost nothing beyond
 * `node:fs`.
 *
 * @module dataset/paths
 */

import { existsSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';

function isWithin(root: string, candidate: string): boolean {
  return candidate.startsWith(root + sep);
}

/**
 * Resolves a manifest `file` field to an absolute path confined to `goldenDir`.
 *
 * @param goldenDir - Path to the golden directory that must contain the file.
 * @param file - The manifest entry's `file` field.
 * @returns Absolute path inside `goldenDir`; symlinks are resolved when the file exists.
 * @throws If the path escapes `goldenDir`, whether lexically (`..`, absolute path)
 *   or through a symlink pointing outside it.
 */
export function resolveDatasetPath(goldenDir: string, file: string): string {
  const root = resolve(goldenDir);
  const candidate = resolve(root, file);

  if (!isWithin(root, candidate)) {
    throw new Error(
      `Manifest dataset path "${file}" escapes the golden directory (${root}). ` +
        `Dataset paths must stay inside it; the manifest sha256 is an integrity ` +
        `check, not a confinement boundary.`,
    );
  }

  // A symlink planted inside golden/ passes the lexical test above while
  // pointing anywhere on disk, so confinement is re-checked against real paths.
  if (!existsSync(candidate)) {
    return candidate;
  }

  const realRoot = realpathSync(root);
  const realCandidate = realpathSync(candidate);

  if (!isWithin(realRoot, realCandidate)) {
    throw new Error(
      `Manifest dataset path "${file}" resolves outside the golden directory ` +
        `(${realCandidate} is not under ${realRoot}).`,
    );
  }

  return realCandidate;
}
