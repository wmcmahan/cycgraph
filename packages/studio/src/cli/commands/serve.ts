/**
 * `serve [--port n] [--watch] [--load file]`: the dashboard over this
 * session's catalog, plus any ad-hoc files loaded on top.
 *
 * @module cli/commands/serve
 */

import { catalogOf } from '../../scenarios/catalog.js';
import { loadScenarioFile } from '../../scenarios/loader.js';
import type { Scenario } from '../../scenarios/types.js';
import { startDashboard } from '../../server/index.js';
import { fail, type CliContext } from '../context.js';

export async function serveCommand(ctx: CliContext): Promise<void> {
  const { args, config } = ctx;
  const portAt = args.indexOf('--port');
  const port = portAt >= 0 ? Number(args[portAt + 1] ?? 5199) : 5199;
  const watch = args.includes('--watch');
  const extras: Scenario[] = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] !== '--load') continue;
    const file = args[++index];
    if (!file) fail('--load needs a file path.');
    extras.push(await loadScenarioFile(file));
  }
  const dashboard = await startDashboard(config, port, {
    auto: watch,
    onLine: (message) => process.stdout.write(`  [watch] ${message}\n`),
  }, catalogOf([...ctx.catalog.scenarios, ...extras]));

  const served = ctx.catalog.scenarios.length + extras.length;
  process.stdout.write(`\n  cycgraph studio  →  http://127.0.0.1:${port}\n`);
  for (const extra of extras) {
    process.stdout.write(`  loaded: ${extra.id} — ${extra.title}\n`);
  }
  // Nothing to run or improve is worth saying at startup rather than
  // leaving the operator to infer it from empty pages.
  process.stdout.write(served === 0
    ? '  no workflows declared — add `graphs` to cycgraph.config.ts, or pass --load <file>\n'
    : `  ${served} workflow(s) in this catalog\n`);
  process.stdout.write(watch
    ? `  watcher: automatic — completed runs accumulate toward a tick\n\n`
    : `  watcher: manual — trigger ticks from the page, or restart with --watch\n\n`);

  // Held open by the listening socket; the process ends on Ctrl-C. Closing
  // through the dashboard releases the stack, which flushes the spans the
  // batching exporter is still holding.
  await new Promise<void>((resolve) => {
    const stop = (): void => { void dashboard.close().then(resolve); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
}
