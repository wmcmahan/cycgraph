/**
 * `run <workflow>`: one execution with the ledger's accepted proposals
 * applied, streamed to the terminal.
 *
 * @module cli/commands/run
 */

import { describeParams } from '../../params/introspect.js';
import { executeScenario } from '../../run/execute.js';
import { trialChangesFor } from '../../improve/proposals.js';
import { resolveStack } from '../../stack/index.js';
import { parseFlags } from '../flags.js';
import { requireFeatures, type CliContext } from '../context.js';
import { renderEvent, renderOutcome, renderStack } from '../render.js';

export async function runCommand(ctx: CliContext): Promise<void> {
  const { args, config } = ctx;
  const scenario = await ctx.requireScenario(args[0]);
  const stack = await resolveStack(config);
  requireFeatures(stack, scenario);

  const fields = describeParams(scenario.params);
  const params = scenario.params.parse(parseFlags(args.slice(1), fields));

  renderStack(stack);
  process.stdout.write(`  ── ${scenario.id} ──\n`);

  // What is applied is decided at the ledger, not per invocation: a run
  // of this scenario is a run of it as currently accepted.
  const accepted = await trialChangesFor(config.artifactRoot, scenario.id);
  if (accepted.ids.length > 0) {
    process.stdout.write(`  applying ${accepted.ids.length} proposal(s): ${accepted.ids.join(', ')}\n`);
  }

  try {
    const outcome = await executeScenario(scenario, params, stack, {
      onProgress: renderEvent,
      fallbackHitl: ctx.promptForHuman,
      ...(accepted.ids.length > 0 ? { apply: accepted } : {}),
    });

    renderOutcome(outcome);
    process.exitCode = outcome.status === 'completed' ? 0 : 1;
  } finally {
    await stack.close();
  }
}
