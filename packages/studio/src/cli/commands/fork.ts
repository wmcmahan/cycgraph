/**
 * `fork <workflow> [--at node] [--prompt n=v] [--model n=v] [--memoize]`:
 * record a base run, then re-run its tail under a declarative change.
 *
 * @module cli/commands/fork
 */

import { change, type Change, type ForkPoint } from '@cycgraph/orchestrator';
import { describeParams } from '../../params/introspect.js';
import { executeScenario } from '../../run/execute.js';
import { forkRecordedRun } from '../../run/fork.js';
import { resolveStack } from '../../stack/index.js';
import { parseFlags } from '../flags.js';
import { fail, requireFeatures, type CliContext } from '../context.js';
import { renderEvent, renderFork, renderOutcome, renderStack } from '../render.js';

/** Fork-specific flags, peeled off before the scenario's own parameters. */
interface ForkFlags {
  at?: ForkPoint;
  changes: Change[];
  memoize: boolean;
  rest: string[];
}

/**
 * Split `--at`, `--model`, `--prompt` and `--memoize` out of the argument
 * list. `--model` and `--prompt` take `target=value`, where target is a node
 * id and optionally a dotted role, matching what `change.*` accepts.
 */
function takeForkFlags(argv: readonly string[]): ForkFlags {
  const flags: ForkFlags = { changes: [], memoize: false, rest: [] };

  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    const pair = (): [string, string] => {
      const raw = argv[++index] ?? '';
      const split = raw.indexOf('=');
      if (split < 1) fail(`${token} expects <node>=<value>, got '${raw}'`);
      return [raw.slice(0, split), raw.slice(split + 1)];
    };

    switch (token) {
      case '--at': {
        const value = argv[++index] ?? '';
        flags.at = value === 'start' || value === 'failure'
          ? value
          : { beforeNode: value };
        continue;
      }
      case '--model': {
        const [target, model] = pair();
        flags.changes.push(change.model(target, model));
        continue;
      }
      case '--prompt': {
        const [target, prompt] = pair();
        flags.changes.push(change.prompt(target, prompt));
        continue;
      }
      case '--memoize':
        flags.memoize = true;
        continue;
      default:
        flags.rest.push(token);
    }
  }

  return flags;
}

export async function forkCommand(ctx: CliContext): Promise<void> {
  const { args, config } = ctx;
  const scenario = await ctx.requireScenario(args[0]);
  const stack = await resolveStack(config);
  requireFeatures(stack, scenario);

  const fields = describeParams(scenario.params);
  const forkFlags = takeForkFlags(args.slice(1));
  const params = scenario.params.parse(parseFlags(forkFlags.rest, fields));

  renderStack(stack);
  process.stdout.write(`  ── ${scenario.id} ──\n`);

  try {
    // Fork what this process just recorded. A run from an earlier process
    // is only reachable when the event log is durable, which is what
    // --postgres gives it.
    const base = await executeScenario(scenario, params, stack, {
      onProgress: renderEvent,
      fallbackHitl: ctx.promptForHuman,
    });
    renderOutcome(base);

    if (!base.finalState) fail(`${scenario.id} produced no final state, so there is nothing to fork.`);

    const outcome = await forkRecordedRun(scenario, params, stack, base.runId, {
      ...(forkFlags.at ? { at: forkFlags.at } : {}),
      ...(forkFlags.changes.length > 0 ? { change: forkFlags.changes } : {}),
      ...(forkFlags.memoize ? { memoize: true } : {}),
    });

    renderFork(outcome);
    process.exitCode = 0;
  } finally {
    await stack.close();
  }
}
