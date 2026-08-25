/**
 * `loop <workflow>`: the self-improvement cycle, unattended.
 *
 * Runs the workflow until it has a corpus, measures it, and climbs as far
 * as `--autonomy` allows — by default all the way to a branch with the
 * change committed and the diff printed. Pushing stays yours.
 *
 * @module cli/commands/loop
 */

import { resolveStack } from '../../stack/index.js';
import { runImproveLoop, type LoopAutonomy } from '../../improve/loop.js';
import { fail, requireFeatures, type CliContext } from '../context.js';
import { renderStack } from '../render.js';

const AUTONOMY: readonly LoopAutonomy[] = ['propose', 'trial', 'apply'];

export async function loopCommand(ctx: CliContext): Promise<void> {
  const { args, config } = ctx;
  const workflow = await ctx.requireScenario(args[0]);
  const stack = await resolveStack(config);
  requireFeatures(stack, workflow);

  const numeric = (flag: string): number | undefined => {
    const at = args.indexOf(flag);
    return at >= 0 ? Math.max(1, Number(args[at + 1] ?? 0)) : undefined;
  };
  const autonomyAt = args.indexOf('--autonomy');
  const autonomy = autonomyAt >= 0 ? args[autonomyAt + 1] : undefined;
  if (autonomy !== undefined && !AUTONOMY.includes(autonomy as LoopAutonomy)) {
    await stack.close();
    fail(`--autonomy must be one of ${AUTONOMY.join(', ')}`);
  }
  const modelsAt = args.indexOf('--models');
  const models = modelsAt >= 0
    ? (args[modelsAt + 1] ?? '').split(',').map((m) => m.trim()).filter(Boolean)
    : [];
  const repoAt = args.indexOf('--repo');

  renderStack(stack);
  process.stdout.write(`  ── loop ${workflow.id} ──\n`);

  // Ctrl-C stops after the step in flight rather than orphaning a run.
  const aborter = new AbortController();
  const stop = (): void => {
    process.stdout.write('\n  stopping after the current step…\n');
    aborter.abort();
  };
  process.on('SIGINT', stop);

  try {
    const result = await runImproveLoop(stack, workflow, {
      signal: aborter.signal,
      ...(autonomy ? { autonomy: autonomy as LoopAutonomy } : {}),
      ...(numeric('--max-runs') !== undefined ? { maxRuns: numeric('--max-runs')! } : {}),
      ...(numeric('--max-minutes') !== undefined ? { maxMinutes: numeric('--max-minutes')! } : {}),
      ...(numeric('--max-forks') !== undefined ? { maxForks: numeric('--max-forks')! } : {}),
      ...(numeric('--trial-runs') !== undefined ? { trialRuns: numeric('--trial-runs')! } : {}),
      ...(numeric('--prompts') !== undefined ? { prompts: numeric('--prompts')! } : {}),
      ...(models.length > 0 ? { models } : {}),
      ...(repoAt >= 0 && args[repoAt + 1] ? { repoRoot: args[repoAt + 1]! } : {}),
      onEvent: (event) => process.stdout.write(`  ${event.message}\n`),
    });

    process.stdout.write(`\n  ${result.runs} run(s), ${result.measures} measurement(s)`);
    process.stdout.write(result.proposals.length > 0 ? `, proposed ${result.proposals.join(', ')}\n` : '\n');

    if (result.applied) {
      process.stdout.write(`\n${result.applied.diff}\n`);
      process.stdout.write(`  committed to ${result.applied.branch} in ${result.applied.repoRoot}\n`);
      if (result.applied.fixture) {
        process.stdout.write('  (that repository is a throwaway fixture — the studio does not track your source)\n');
      }
      process.stdout.write(`  to open the PR:\n${result.applied.prCommand.split('\n').map((l) => `    ${l}`).join('\n')}\n`);
    }
    process.stdout.write(`  ${result.stoppedBecause}\n`);
    // A refused apply is a real outcome the operator must see, not a crash
    // and not a success.
    process.exitCode = result.applyError ? 1 : 0;
  } finally {
    process.off('SIGINT', stop);
    await stack.close();
  }
}
