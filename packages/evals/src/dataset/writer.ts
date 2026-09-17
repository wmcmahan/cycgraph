/**
 * Golden Dataset Writer
 *
 * Writes golden trajectories to compressed SQLite files and
 * updates the manifest. Used by seed and migration scripts.
 *
 * @module dataset/writer
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { GoldenTrajectorySchema } from './schema.js';
import { loadManifest } from './loader.js';
import type { GoldenTrajectory, Manifest, SuiteName } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Default path to the golden directory relative to package root. */
const GOLDEN_DIR = resolve(__dirname, '../../golden');

/**
 * Creates a SQLite database buffer containing the given trajectories.
 *
 * The database has a single `trajectories` table with an `id` column
 * and a `data` column containing the JSON-serialized trajectory.
 */
export function createSqliteBuffer(trajectories: GoldenTrajectory[]): Buffer {
  const db = new Database(':memory:');

  db.exec(`
    CREATE TABLE trajectories (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL
    )
  `);

  const insert = db.prepare('INSERT INTO trajectories (id, data) VALUES (?, ?)');
  const insertMany = db.transaction((items: GoldenTrajectory[]) => {
    for (const t of items) {
      insert.run(t.id, JSON.stringify(t));
    }
  });

  insertMany(trajectories);

  const buffer = db.serialize();
  db.close();

  return Buffer.from(buffer);
}

/**
 * Writes trajectories for a suite to a compressed SQLite file and updates the manifest.
 *
 * @param suite - The suite name.
 * @param trajectories - Validated trajectories to write.
 * @param schemaVersion - Schema version string for the manifest entry.
 * @param goldenDir - Path to the golden directory.
 * @throws If a trajectory fails validation, or if an existing manifest cannot be
 *   parsed and validated — a corrupt manifest fails the write before any file is
 *   touched, since replacing it would deregister every other suite's dataset and
 *   overwriting the dataset would desynchronize it from the recorded checksum.
 */
export function writeGoldenDataset(
  suite: SuiteName,
  trajectories: GoldenTrajectory[],
  schemaVersion: string,
  goldenDir: string = GOLDEN_DIR,
): void {
  // Validate all trajectories before writing
  for (const t of trajectories) {
    GoldenTrajectorySchema.parse(t);
  }

  // Create SQLite and compress
  const sqliteBuffer = createSqliteBuffer(trajectories);
  const compressed = gzipSync(sqliteBuffer);
  const sha256 = createHash('sha256').update(compressed).digest('hex');

  // Read the manifest before anything touches the disk: rewriting a suite at the
  // same major version replaces its `.sqlite.gz` in place, so a manifest that
  // throws after that write would leave the old sha256 pointing at new bytes.
  const manifestPath = resolve(goldenDir, 'manifest.json');
  const manifest: Manifest = existsSync(manifestPath)
    ? loadManifest(goldenDir)
    : { version: '1', datasets: [] };

  // Write compressed file. The filename encodes the schema MAJOR version so
  // datasets of different major versions coexist on disk instead of
  // overwriting each other in place, which would make a migration
  // irreversible with no way to roll back to the prior goldens.
  const dataDir = resolve(goldenDir, 'data');
  mkdirSync(dataDir, { recursive: true });

  const major = /^(\d+)/.exec(schemaVersion)?.[1] ?? '1';
  const filename = `${suite}-v${major}.sqlite.gz`;
  const filePath = resolve(dataDir, filename);
  writeFileSync(filePath, compressed);

  const existingIndex = manifest.datasets.findIndex(d => d.name === suite);
  const entry = {
    name: suite,
    file: `data/${filename}`,
    sha256,
    trajectoryCount: trajectories.length,
    schemaVersion,
    lastUpdated: new Date().toISOString(),
  };

  if (existingIndex >= 0) {
    manifest.datasets[existingIndex] = entry;
  } else {
    manifest.datasets.push(entry);
  }

  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
}
