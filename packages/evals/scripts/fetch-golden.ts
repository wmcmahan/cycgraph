/**
 * Fetch Golden Dataset
 *
 * Downloads golden dataset files during the build step. If
 * GOLDEN_DATASET_URL is set, downloads from the remote URL.
 * Otherwise, verifies that local LFS files exist.
 *
 * Usage:
 *   npx tsx scripts/fetch-golden.ts
 *   npm run fetch-golden --workspace=packages/evals
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ManifestSchema } from '../src/dataset/schema.js';
import { resolveDatasetPath } from '../src/dataset/loader.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GOLDEN_DIR = resolve(__dirname, '../golden');

async function main(): Promise<void> {
  const remoteUrl = process.env['GOLDEN_DATASET_URL'];

  if (remoteUrl) {
    console.log(`Fetching golden dataset from: ${remoteUrl}`);
    // Remote fetch is reserved for future implementation.
    // When implemented, this will download and extract a tarball
    // or individual .sqlite.gz files to golden/data/.
    console.error('Remote dataset fetch is not yet implemented.');
    process.exitCode = 1;
    return;
  }

  // Local mode — verify LFS files exist
  console.log('Verifying local golden dataset files...\n');

  const manifestPath = resolve(GOLDEN_DIR, 'manifest.json');
  if (!existsSync(manifestPath)) {
    console.log('No manifest found. Run `npx tsx scripts/seed-golden.ts` to create initial datasets.');
    return;
  }

  const raw = readFileSync(manifestPath, 'utf-8');
  const manifest = ManifestSchema.parse(JSON.parse(raw));

  if (manifest.datasets.length === 0) {
    console.log('Manifest is empty. Run `npx tsx scripts/seed-golden.ts` to create initial datasets.');
    return;
  }

  let allPresent = true;

  for (const entry of manifest.datasets) {
    const filePath = resolveDatasetPath(GOLDEN_DIR, entry.file);
    const exists = existsSync(filePath);
    const status = exists ? 'OK' : 'MISSING';

    console.log(`  [${status}] ${entry.name} — ${entry.file} (${entry.trajectoryCount} trajectories)`);

    if (!exists) {
      allPresent = false;
    }
  }

  console.log('');

  if (!allPresent) {
    console.error('Some dataset files are missing. Ensure Git LFS files are pulled: git lfs pull');
    process.exitCode = 1;
  } else {
    console.log('All golden dataset files present.');
  }
}

main();
