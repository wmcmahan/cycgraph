/**
 * `tune <workflow>`: measure knob changes against the workflow's evals by
 * forking recorded runs, and optionally save what wins to the ledger.
 *
 * @module cli/commands/tune
 */

import { describeParams } from '../../params/introspect.js';
import { saveProposals } from '../../improve/proposals.js';
import { tuneWorkflow } from '../../improve/tune.js';
import { resolveStack } from '../../stack/index.js';
import { parseFlags } from '../flags.js';
import { requireFeatures, type CliContext } from '../context.js';
import { renderStack, renderTune, renderTuneEstimate } from '../render.js';

export async function tuneCommand(ctx: CliContext): Promise<void> {
  const { args, config } = ctx;
  const scenario = await ctx.requireScenario(args[0]);
  const stack = await resolveStack(config);
  requireFeatures(stack, scenario);

  const fields = describeParams(scenario.params);
  // Peeled off before the scenario's own parameters, which is what the
  // remaining argv is parsed as.
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
  const prompts = numeric('--prompts');
  const noCombine = args.includes('--no-combine');
  const reuse = args.includes('--reuse');
  const save = args.includes('--save');

  const modelsAt = args.indexOf('--models');
  const models = modelsAt >= 0
    ? (args[modelsAt + 1] ?? '').split(',').map((m) => m.trim()).filter(Boolean)
    : undefined;

  const tuneFlags = ['--prefixes', '--max-forks', '--max-seconds', '--models', '--samples', '--validate', '--prompts', '--concurrency'];
  const rest: string[] = [];
  for (let index = 1; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--dry-run' || arg === '--no-combine' || arg === '--reuse' || arg === '--save') continue;
    if (arg !== undefined && tuneFlags.includes(arg)) { index++; continue; }
    if (arg !== undefined) rest.push(arg);
  }
  const params = scenario.params.parse(parseFlags(rest, fields));

  renderStack(stack);
  process.stdout.write(`  ── ${scenario.id} ──\n`);

  try {
    // The graph the sweep reads current knob values from. Built rather
    // than loaded, because a knob's value is a property of the authoring
    // and the enumerator only reads it.
    const built = await scenario.build(params as never, stack);
    const outcome = await tuneWorkflow(scenario, params, stack, built.graph, {
      ...(prefixes !== undefined ? { prefixes } : {}),
      ...(maxForks !== undefined ? { maxForks } : {}),
      ...(maxSeconds !== undefined ? { maxSeconds } : {}),
      ...(models?.length ? { models } : {}),
      ...(samples !== undefined ? { samples } : {}),
      ...(validate !== undefined ? { validate } : {}),
      ...(concurrency !== undefined ? { concurrency } : {}),
      ...(prompts !== undefined ? { prompts } : {}),
      ...(noCombine ? { noCombine: true } : {}),
      ...(reuse ? { reuse: true } : {}),
      ...(args.includes('--dry-run') ? { dryRun: true } : {}),
      onEstimate: renderTuneEstimate,
      onProgress: (message) => process.stdout.write(`  ${message}\n`),
    });

    if (save) {
      outcome.savedProposals = await saveProposals(config.artifactRoot, outcome);
      if (outcome.savedProposals.length > 0) {
        process.stdout.write(`  saved ${outcome.savedProposals.length} proposal(s): ${outcome.savedProposals.join(', ')}\n`);
      } else {
        process.stdout.write('  nothing to save: the pass produced no proposals\n');
      }
    }
    renderTune(outcome);
  } finally {
    await stack.close();
  }
}
