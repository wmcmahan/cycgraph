/**
 * `import <runId>|--all`: pull externally recorded runs into the artifact
 * tree, so sensing sees what any process persisted.
 *
 * @module cli/commands/import
 */

import { importAll, importRun } from '../../run/import.js';
import { resolveStack } from '../../stack/index.js';
import type { CliContext } from '../context.js';

export async function importCommand(ctx: CliContext): Promise<void> {
  const { args, config } = ctx;
  const stack = await resolveStack(config);
  try {
    const outcomes = args[0] && args[0] !== '--all'
      ? [await importRun(stack, args[0])]
      : await importAll(stack);
    if (outcomes.length === 0) {
      process.stdout.write(`  nothing to import — every persisted run is already in the artifact tree\n`);
    }
    for (const outcome of outcomes) {
      process.stdout.write(outcome.imported
        ? `  ${outcome.runId.slice(0, 8)} → ${outcome.workflow} (${outcome.timings} node timing(s))\n`
        : `  ${outcome.runId.slice(0, 8)} skipped: ${outcome.reason}\n`);
    }
    process.exitCode = outcomes.some((outcome) => !outcome.imported && outcome.reason !== 'already in the artifact tree') ? 1 : 0;
  } finally {
    await stack.close();
  }
}
