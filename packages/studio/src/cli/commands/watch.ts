/**
 * `watch [workflow]`: one watcher tick — sense the recorded corpus,
 * measure what a finding motivates, propose.
 *
 * @module cli/commands/watch
 */

import { watchTick } from '../../improve/watch.js';
import { resolveStack } from '../../stack/index.js';
import type { CliContext } from '../context.js';
import { renderStack, renderWatch } from '../render.js';

export async function watchCommand(ctx: CliContext): Promise<void> {
  const { args, config } = ctx;
  const stack = await resolveStack(config);
  const numeric = (flag: string): number | undefined => {
    const at = args.indexOf(flag);
    return at >= 0 ? Math.max(1, Number(args[at + 1] ?? 0)) : undefined;
  };
  const target = args[0] && !args[0].startsWith('--') ? await ctx.requireScenario(args[0]) : undefined;
  const scenarios = target ? [target] : [...ctx.catalog.scenarios];

  renderStack(stack);
  process.stdout.write(`  ── watch ──\n`);

  try {
    const rows = await watchTick(stack, scenarios, {
      ...(numeric('--min-runs') !== undefined ? { minRuns: numeric('--min-runs')! } : {}),
      ...(numeric('--max-forks') !== undefined ? { maxForks: numeric('--max-forks')! } : {}),
      ...(numeric('--max-seconds') !== undefined ? { maxSeconds: numeric('--max-seconds')! } : {}),
      ...(args.includes('--dry-run') ? { dryRun: true } : {}),
      onProgress: (message) => process.stdout.write(`  ${message}\n`),
    });
    renderWatch(rows);
  } finally {
    await stack.close();
  }
}
