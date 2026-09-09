/**
 * Migrate Golden Dataset
 *
 * Applies migration transforms to golden trajectories when tool
 * signatures change in sibling packages. Reads transforms from
 * a migration definition, applies them, and writes updated datasets.
 *
 * Usage:
 *   npx tsx scripts/migrate-golden.ts
 *
 * Migration transforms are defined programmatically below. Edit the
 * `transforms` array for each migration, then run the script.
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGoldenTrajectories, loadManifest, listAvailableSuites } from '../src/dataset/loader.js';
import { writeGoldenDataset } from '../src/dataset/writer.js';
import { applyMigrations, nextMajorSchemaVersion } from '../src/dataset/migration.js';
import type { MigrationTransform } from '../src/dataset/migration.js';
import type { SuiteName } from '../src/dataset/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GOLDEN_DIR = resolve(__dirname, '../golden');

// ─── Define Transforms ─────────────────────────────────────────────
// Edit this array for each migration run. Clear after applying.

const transforms: MigrationTransform[] = [
  // Example:
  // { type: 'rename', toolName: 'web_search', oldParam: 'query', newParam: 'search_query' },
  // { type: 'remove', toolName: 'save_to_memory', param: 'deprecated_field' },
  // { type: 'add_required', toolName: 'fetch_url', param: 'timeout_ms', stubValue: 5000 },
];

// ─── Migration Runner ──────────────────────────────────────────────

function main(): void {
  if (transforms.length === 0) {
    console.log('No transforms defined. Edit scripts/migrate-golden.ts to add transforms.');
    return;
  }

  console.log(`Applying ${transforms.length} transform(s) to golden datasets...\n`);

  const suites = listAvailableSuites(GOLDEN_DIR);

  if (suites.length === 0) {
    console.log('No datasets found. Run `npx tsx scripts/seed-golden.ts` first.');
    return;
  }

  let totalModified = 0;
  const allReviewItems: Array<{ suite: string; trajectoryId: string; param: string }> = [];

  const manifest = loadManifest(GOLDEN_DIR);

  for (const suite of suites) {
    const trajectories = loadGoldenTrajectories(suite as SuiteName, GOLDEN_DIR);
    const result = applyMigrations(trajectories, transforms);

    if (result.modifiedCount > 0) {
      // Written under the NEXT major so the current dataset file survives
      // as the rollback — a fixed version would overwrite a retained
      // rollback file and downgrade the manifest entry.
      const current = manifest.datasets.find((d) => d.name === suite)?.schemaVersion;
      const next = nextMajorSchemaVersion(current);
      writeGoldenDataset(suite as SuiteName, result.trajectories, next, GOLDEN_DIR);
      console.log(`  ${suite}: ${result.modifiedCount}/${trajectories.length} trajectories updated (schema ${current ?? 'none'} → ${next})`);
    } else {
      console.log(`  ${suite}: no changes`);
    }

    totalModified += result.modifiedCount;

    for (const item of result.reviewRequired) {
      allReviewItems.push({
        suite,
        trajectoryId: item.trajectoryId,
        param: item.transform.param,
      });
    }
  }

  console.log(`\nTotal: ${totalModified} trajectories modified across ${suites.length} suites.`);

  if (allReviewItems.length > 0) {
    console.log('\n⚠ Manual review required for added required parameters:');
    for (const item of allReviewItems) {
      console.log(`  - Suite "${item.suite}", trajectory ${item.trajectoryId}: param "${item.param}" was stubbed`);
    }
  }
}

main();
