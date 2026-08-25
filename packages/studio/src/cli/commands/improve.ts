/**
 * `improve <workflow>`: the whole ladder in one gated pass — tune, record,
 * trial, apply, and the merged epoch, each rung behind a terminal gate.
 *
 * @module cli/commands/improve
 */

import { join, resolve } from 'node:path';
import { describeParams } from '../../params/introspect.js';
import { improveWorkflow } from '../../improve/improve.js';
import { resolveStack } from '../../stack/index.js';
import { parseFlags } from '../flags.js';
import { requireFeatures, type CliContext } from '../context.js';
import { renderEvent, renderOutcome, renderStack } from '../render.js';

export async function improveCommand(ctx: CliContext): Promise<void> {
  const { args, config } = ctx;
  const scenario = await ctx.requireScenario(args[0]);
  const stack = await resolveStack(config);
  requireFeatures(stack, scenario);

  const fields = describeParams(scenario.params);
  const numeric = (flag: string): number | undefined => {
    const at = args.indexOf(flag);
    return at >= 0 ? Math.max(1, Number(args[at + 1] ?? 0)) : undefined;
  };
  const prefixes = numeric('--prefixes');
  const maxForks = numeric('--max-forks');
  const maxSeconds = numeric('--max-seconds');
  const samples = numeric('--samples');
  const validate = numeric('--validate');
  const concurrency = numeric('--concurrency');
  const noCombine = args.includes('--no-combine');
  const reuse = args.includes('--reuse');

  const repoAt = args.indexOf('--repo');
  const repoRoot = repoAt >= 0
    ? resolve(args[repoAt + 1] ?? '.')
    : config.applyRepo ?? resolve(join('..', '..'));

  const improveFlags = ['--prefixes', '--max-forks', '--max-seconds', '--samples', '--validate', '--concurrency', '--repo'];
  const rest: string[] = [];
  for (let index = 1; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--no-combine' || arg === '--reuse') continue;
    if (arg !== undefined && improveFlags.includes(arg)) { index++; continue; }
    if (arg !== undefined) rest.push(arg);
  }
  const params = scenario.params.parse(parseFlags(rest, fields));

  renderStack(stack);
  process.stdout.write(`  ── improve ${scenario.id} ──\n`);

  try {
    const outcome = await improveWorkflow(scenario, params, stack, {
      repoRoot,
      tune: {
        ...(prefixes !== undefined ? { prefixes } : {}),
        ...(maxForks !== undefined ? { maxForks } : {}),
        ...(maxSeconds !== undefined ? { maxSeconds } : {}),
        ...(samples !== undefined ? { samples } : {}),
        ...(validate !== undefined ? { validate } : {}),
        ...(concurrency !== undefined ? { concurrency } : {}),
        ...(noCombine ? { noCombine: true } : {}),
        ...(reuse ? { reuse: true } : {}),
      },
      onProgress: (message) => process.stdout.write(`  ${message}\n`),
      onEvent: renderEvent,
      hitl: ctx.promptForGate,
    });

    renderOutcome(outcome);
    process.exitCode = outcome.status === 'completed' ? 0 : 1;
  } finally {
    await stack.close();
  }
}
