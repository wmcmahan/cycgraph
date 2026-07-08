/**
 * Golden Dataset Loader
 *
 * Reads the golden dataset manifest, decompresses SQLite files,
 * and returns validated golden trajectories for a given suite.
 *
 * @module dataset/loader
 */

import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { GoldenTrajectorySchema, ManifestSchema } from './schema.js';
import type { GoldenTrajectory, Manifest, SuiteName } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Default path to the golden directory relative to package root. */
const GOLDEN_DIR = resolve(__dirname, '../../golden');

/**
 * Reads and validates the golden dataset manifest.
 *
 * @param goldenDir - Path to the golden directory. Defaults to `golden/` at package root.
 * @returns Parsed and validated manifest.
 * @throws If the manifest file is missing or fails validation.
 */
export function loadManifest(goldenDir: string = GOLDEN_DIR): Manifest {
  const manifestPath = resolve(goldenDir, 'manifest.json');
  const raw = readFileSync(manifestPath, 'utf-8');
  return ManifestSchema.parse(JSON.parse(raw));
}

/**
 * Loads golden trajectories for a specific suite from the compressed SQLite dataset.
 *
 * Steps:
 * 1. Read manifest to locate the dataset file for the suite
 * 2. Read the compressed `.sqlite.gz` file
 * 3. Decompress in memory
 * 4. Open as an in-memory SQLite database
 * 5. Query all trajectories and validate each against GoldenTrajectorySchema
 *
 * @param suite - The suite name to load trajectories for.
 * @param goldenDir - Path to the golden directory. Defaults to `golden/` at package root.
 * @returns Array of validated golden trajectories.
 * @throws If the suite is not found in the manifest or trajectories fail validation.
 */
export function loadGoldenTrajectories(
  suite: SuiteName,
  goldenDir: string = GOLDEN_DIR,
): GoldenTrajectory[] {
  const manifest = loadManifest(goldenDir);

  const entry = manifest.datasets.find(d => d.name === suite);
  if (!entry) {
    throw new Error(
      `Suite "${suite}" not found in manifest. Available: ${manifest.datasets.map(d => d.name).join(', ') || '(none)'}`,
    );
  }

  const compressedPath = resolve(goldenDir, entry.file);
  const compressed = readFileSync(compressedPath);

  // Verify the dataset matches the manifest's recorded checksum before trusting
  // it. The writer records this sha256; skipping the check let a tampered or
  // corrupted golden file load silently, defeating the checksum's only purpose.
  const actualSha256 = createHash('sha256').update(compressed).digest('hex');
  if (actualSha256 !== entry.sha256) {
    throw new Error(
      `Golden dataset for suite "${suite}" failed integrity check: manifest sha256 ` +
        `${entry.sha256} != file ${actualSha256} (${entry.file}). The dataset is ` +
        `corrupt or out of sync with the manifest.`,
    );
  }

  const sqliteBuffer = gunzipSync(compressed);

  const db = new Database(sqliteBuffer);
  db.pragma('journal_mode = OFF');

  try {
    const rows = db.prepare('SELECT data FROM trajectories').all() as Array<{ data: string }>;

    return rows.map((row, index) => {
      const parsed = JSON.parse(row.data);
      const result = GoldenTrajectorySchema.safeParse(parsed);

      if (!result.success) {
        throw new Error(
          `Trajectory at index ${index} in suite "${suite}" failed validation: ${result.error.message}`,
        );
      }

      return result.data;
    });
  } finally {
    db.close();
  }
}

/**
 * Lists all suite names available in the manifest.
 *
 * @param goldenDir - Path to the golden directory.
 * @returns Array of suite names with trajectory data.
 */
export function listAvailableSuites(goldenDir: string = GOLDEN_DIR): string[] {
  const manifest = loadManifest(goldenDir);
  return manifest.datasets.map(d => d.name);
}
