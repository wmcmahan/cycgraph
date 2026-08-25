/**
 * `sweep <workflow> --vary p=a,b [--repeat n]`: every combination of the
 * varied parameters, each run scored against the workflow's evals.
 *
 * @module cli/commands/sweep
 */

import { describeParams } from '../../params/introspect.js';
import { runSweep } from '../../run/sweep.js';
import { isLocalModel, resolveStack, unmetRequirements } from '../../stack/index.js';
import { parseFlags, takeSweepAxes } from '../flags.js';
import { fail, type CliContext } from '../context.js';
import { renderStack, renderSweep } from '../render.js';

/** Sweep-only flags, stripped before scenario flags are parsed. */
function takeSweepFlags(argv: string[]): { repeat: number; allowSpend: boolean; rest: string[] } {
  let repeat = 1;
  let allowSpend = false;
  const rest: string[] = [];

  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === '--repeat') {
      repeat = Math.max(1, Number(argv[++index] ?? 1));
      continue;
    }
    if (token === '--allow-spend') {
      allowSpend = true;
      continue;
    }
    if (token !== undefined) rest.push(token);
  }

  return { repeat, allowSpend, rest };
}

export async function sweepCommand(ctx: CliContext): Promise<void> {
  const { args, config } = ctx;
  const scenario = await ctx.requireScenario(args[0]);
  const stack = await resolveStack(config);

  const missing = unmetRequirements(stack, scenario.requires);
  if (missing.length > 0) {
    const reasons = stack.gaps
      .filter((gap) => missing.includes(gap.feature))
      .map((gap) => `    ${gap.feature}: ${gap.reason}`)
      .join('\n');
    await stack.close();
    fail(`${scenario.id} cannot run.\n\n${reasons}`);
  }

  const fields = describeParams(scenario.params);
  const { axes, rest: withoutAxes } = takeSweepAxes(args.slice(1), fields);
  if (axes.length === 0) {
    await stack.close();
    fail('A sweep needs at least one --vary <param>=<a,b>. `params <scenario>` lists them.');
  }

  const { repeat, allowSpend, rest: scenarioArgs } = takeSweepFlags(withoutAxes);
  const base = parseFlags(scenarioArgs, fields);

  // A sweep multiplies every run's cost, so a hosted model is opt-in
  // rather than something you discover from the bill.
  if (!isLocalModel(stack.config.model) && !allowSpend) {
    await stack.close();
    fail(
      `Sweeping on ${stack.config.model} costs real money. ` +
      'Re-run with --allow-spend, or use a local model.',
    );
  }

  try {
    renderStack(stack);
    const result = await runSweep(scenario, base, axes, repeat, stack, {
      onVariantStart: (variant, index, total) => {
        const shown = Object.entries(variant).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ');
        process.stdout.write(`  [${index + 1}/${total}] ${shown}\n`);
      },
    });
    renderSweep(result);
    process.exitCode = result.passed === result.entries.length ? 0 : 1;
  } finally {
    await stack.close();
  }
}
