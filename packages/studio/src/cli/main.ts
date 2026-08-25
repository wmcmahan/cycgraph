/**
 * Studio CLI: the dispatcher.
 *
 * Scenario-agnostic: every verb resolves workflows through the catalog the
 * harness supplies. The playground passes its stress registry and registers
 * its conformance commands; the studio's own bin builds a catalog from the
 * user's config file. Ad-hoc files load on top of either.
 *
 * Each verb lives in `commands/`; internal and host-registered commands
 * receive the same {@link CliContext}, so the dispatch table and
 * `harness.commands` are one mechanism.
 *
 * @module cli/main
 */

// The engine's log level defaults to `error`, which would leave `logs.ndjson`
// empty for most runs. Resolution is lazy, so setting it before the first log
// line is enough. An explicit LOG_LEVEL still wins.
process.env['LOG_LEVEL'] ??= 'info';

// Metrics are opt-in and nothing here ever opted in, so the instruments were
// never exercised by a real run. `serve` exposes them at /metrics.
process.env['METRICS_ENABLED'] ??= 'true';

import { FlagError } from './flags.js';
import { commandContext, takeStackFlags, type CliContext, type CliHarness } from './context.js';
import { renderUsage } from './render.js';
import { listCommand, paramsCommand, stackCommand } from './commands/catalog.js';
import { runCommand } from './commands/run.js';
import { forkCommand } from './commands/fork.js';
import { sweepCommand } from './commands/sweep.js';
import { serveCommand } from './commands/serve.js';
import { historyCommand, insightsCommand, logsCommand } from './commands/artifacts.js';
import { watchCommand } from './commands/watch.js';
import { tuneCommand } from './commands/tune.js';
import { improveCommand } from './commands/improve.js';
import { importCommand } from './commands/import.js';
import { loopCommand } from './commands/loop.js';
import {
  applyCommand,
  mergedCommand,
  proposalsCommand,
  revertCommand,
  trialCommand,
} from './commands/proposals.js';

export type { CliContext, CliHarness } from './context.js';

const COMMANDS: Record<string, (ctx: CliContext) => Promise<void>> = {
  stack: stackCommand,
  params: paramsCommand,
  run: runCommand,
  fork: forkCommand,
  sweep: sweepCommand,
  serve: serveCommand,
  logs: logsCommand,
  history: historyCommand,
  insights: insightsCommand,
  watch: watchCommand,
  tune: tuneCommand,
  improve: improveCommand,
  loop: loopCommand,
  import: importCommand,
  proposals: proposalsCommand,
  trial: trialCommand,
  apply: applyCommand,
  merged: mergedCommand,
  revert: revertCommand,
};

/** Run one CLI invocation against a harness. */
export async function runCli(argv: string[], harness: CliHarness): Promise<void> {
  const { config, rest } = takeStackFlags(argv, harness.stackDefaults);
  const [command, ...args] = rest;
  const ctx = commandContext(harness.catalog, config, args);

  if (command === undefined) {
    await listCommand(ctx);
    return;
  }

  const handler = COMMANDS[command] ?? harness.commands?.[command];
  if (!handler) {
    renderUsage();
    process.exitCode = 1;
    return;
  }
  await handler(ctx);
}

/** Process entry: run the CLI against a harness, mapping errors to exit codes. */
export function runCliMain(harness: CliHarness): void {
  runCli(process.argv.slice(2), harness).catch((err: unknown) => {
    if (err instanceof FlagError) {
      process.stderr.write(`\n  ${err.message}\n\n`);
      process.exitCode = 1;
      return;
    }
    process.stderr.write(`\n  Crashed: ${err instanceof Error ? err.stack : String(err)}\n\n`);
    process.exitCode = 1;
  });
}
