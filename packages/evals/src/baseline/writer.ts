/**
 * Baseline Writer
 *
 * Persists a `BaselineSnapshot` to disk under `golden/baselines/`. Each
 * write produces:
 *   - `main-latest.json` — overwritten on every successful commit
 *   - `<timestamp>-<sha>.json` — archived copy for historical comparison
 *
 * Writes are intentionally idempotent within a single run: calling
 * `writeBaseline` with the same snapshot twice produces the same bytes
 * on disk.
 *
 * @module baseline/writer
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BaselineSnapshot } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_GOLDEN_DIR = resolve(__dirname, '../../golden');

/** Paths written by {@link writeBaseline}. */
export interface WriteBaselineResult {
  /** Absolute path to the always-current `main-latest.json`. */
  latestPath: string;
  /** Absolute path to the archived per-timestamp file. */
  archivePath: string;
}

/**
 * Persist a snapshot to `golden/baselines/`. Creates the directory tree
 * if it doesn't yet exist.
 *
 * @param snapshot - The snapshot to write.
 * @param goldenDir - Optional override for the golden directory root.
 */
export function writeBaseline(
  snapshot: BaselineSnapshot,
  goldenDir: string = DEFAULT_GOLDEN_DIR,
): WriteBaselineResult {
  const baselineDir = resolve(goldenDir, 'baselines');
  mkdirSync(baselineDir, { recursive: true });

  const body = JSON.stringify(snapshot, null, 2) + '\n';
  const latestPath = resolve(baselineDir, 'main-latest.json');
  const archivePath = resolve(baselineDir, archiveFilename(snapshot));

  writeFileSync(latestPath, body);
  writeFileSync(archivePath, body);

  return { latestPath, archivePath };
}

/**
 * Build the archive filename from a snapshot. Format:
 *   `<ISO-without-punct>-<commit-or-nocommit>.json`
 *
 * Punctuation is stripped from the timestamp so the filename is shell-safe
 * and sorts chronologically as a string.
 */
function archiveFilename(snapshot: BaselineSnapshot): string {
  const ts = snapshot.generatedAt.replace(/[:.]/g, '').replace(/-/g, '');
  const commit = snapshot.commit ?? 'nocommit';
  return `${ts}-${commit}.json`;
}
