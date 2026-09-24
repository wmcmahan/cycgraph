/**
 * Environment resolution: the one place that maps env vars onto a
 * `MaintenanceEnv`, so a workflow file in CI and a local run configure
 * the same knobs the same way.
 *
 * Variables: `CYCGRAPH_MODEL` and optionally `CYCGRAPH_PROVIDER` (else
 * inferred from the model id), the per-tier overrides
 * `CYCGRAPH_MODEL_HIGH` / `CYCGRAPH_MODEL_MEDIUM` / `CYCGRAPH_MODEL_LOW`
 * (each falls back to `CYCGRAPH_MODEL`), plus the publish variables
 * `publishConfigFromEnv` reads (`GH_TOKEN`/`GITHUB_TOKEN`,
 * `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`).
 *
 * @module maintenance/env
 */

import { publishConfigFromEnv } from '@cycgraph/tools/git';
import { defaultMaintenanceContext } from './context.js';
import type { MaintenanceContext } from './context.js';
import type { MaintenanceEnv } from '../types.js';

/** Provider inferred from a model id: hosted prefixes, else local Ollama. */
export function inferProvider(model: string): string {
  if (/^claude/i.test(model)) return 'anthropic';
  if (/^gpt/i.test(model)) return 'openai';
  return 'ollama';
}

/**
 * Resolve a `MaintenanceEnv` from environment variables, carrying the
 * given context (this repository's default unless overridden). The
 * context's `identity` is the commit identity when the environment
 * supplies none.
 */
export function maintenanceEnvFromProcess(
  env: Record<string, string | undefined> = process.env,
  context: MaintenanceContext = defaultMaintenanceContext(),
): MaintenanceEnv {
  const model = env['CYCGRAPH_MODEL'] ?? 'qwen2.5:7b';
  // CI passes unset repository variables through as empty strings.
  const tierVar = (name: string): string | undefined => {
    const value = env[name];
    return value !== undefined && value !== '' ? value : undefined;
  };
  const high = tierVar('CYCGRAPH_MODEL_HIGH');
  const medium = tierVar('CYCGRAPH_MODEL_MEDIUM');
  const low = tierVar('CYCGRAPH_MODEL_LOW');
  const tiers = {
    ...(high !== undefined ? { high } : {}),
    ...(medium !== undefined ? { medium } : {}),
    ...(low !== undefined ? { low } : {}),
  };
  // Every tier model must share the run's one provider: agents keep it
  // alongside their tier model, and only its stack is registered. With an
  // explicit CYCGRAPH_PROVIDER the operator owns that claim; when the
  // provider is inferred, a tier model that infers differently is a
  // misconfiguration caught here instead of failing mid-run.
  if (env['CYCGRAPH_PROVIDER'] === undefined) {
    const provider = inferProvider(model);
    for (const [tier, tierModel] of Object.entries(tiers)) {
      const tierProvider = inferProvider(tierModel);
      if (tierProvider !== provider) {
        throw new Error(
          `CYCGRAPH_MODEL_${tier.toUpperCase()} "${tierModel}" resolves to provider "${tierProvider}" ` +
            `but the run's provider is "${provider}"; every tier model must share one provider. ` +
            'Set CYCGRAPH_PROVIDER explicitly to override the inference.',
        );
      }
    }
  }
  const fromEnv = publishConfigFromEnv(env);
  const identity = fromEnv.identity ?? context.identity;
  return {
    model,
    ...(Object.keys(tiers).length > 0 ? { models: tiers } : {}),
    provider: env['CYCGRAPH_PROVIDER'] ?? inferProvider(model),
    publish: {
      ...fromEnv,
      ...(identity !== undefined ? { identity } : {}),
      labels: [context.labels.managed],
    },
    context,
  };
}
