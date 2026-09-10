/**
 * Environment resolution: the one place that maps env vars onto a
 * `MaintenanceEnv`, so a workflow file in CI and a local run configure
 * the same knobs the same way.
 *
 * Variables: `CYCGRAPH_MODEL` and optionally `CYCGRAPH_PROVIDER` (else
 * inferred from the model id), plus the publish variables
 * `publishConfigFromEnv` reads (`GH_TOKEN`/`GITHUB_TOKEN`,
 * `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`).
 *
 * @module maintenance/env
 */

import { publishConfigFromEnv } from '@cycgraph/tools/git';
import { MANAGED_LABEL } from './repo.js';
import type { MaintenanceEnv } from './types.js';

/** Provider inferred from a model id: hosted prefixes, else local Ollama. */
export function inferProvider(model: string): string {
  if (/^claude/i.test(model)) return 'anthropic';
  if (/^gpt/i.test(model)) return 'openai';
  return 'ollama';
}

/** Resolve a `MaintenanceEnv` from environment variables. */
export function maintenanceEnvFromProcess(
  env: Record<string, string | undefined> = process.env,
): MaintenanceEnv {
  const model = env['CYCGRAPH_MODEL'] ?? 'qwen2.5:7b';
  return {
    model,
    provider: env['CYCGRAPH_PROVIDER'] ?? inferProvider(model),
    publish: { ...publishConfigFromEnv(env), labels: [MANAGED_LABEL] },
  };
}
