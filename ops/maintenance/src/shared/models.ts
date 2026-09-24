/**
 * Per-tier model selection for maintenance agents.
 *
 * A `MaintenanceEnv` carries one required `model` and an optional
 * `models` tier map. Each agent declares the capability tier its role
 * needs and resolves it here, so a single-model environment runs every
 * agent on `env.model` exactly as it did before the map existed.
 *
 * Every tier model must belong to `env.provider`: agents keep the env's
 * provider alongside the resolved model, and the run registers only that
 * provider's stack. `maintenanceEnvFromProcess` enforces the invariant
 * when the provider is inferred; an explicit `CYCGRAPH_PROVIDER` is the
 * operator's assertion and skips the check.
 *
 * Every agent sets both `modelPreference` and `effort` explicitly. The
 * provider's default effort differs between model generations, so a
 * high-tier agent names `high` rather than inheriting it.
 *
 * @module maintenance/shared/models
 */

import { defaultModelResolver } from '@cycgraph/orchestrator';
import type { ModelResolver, ModelTier } from '@cycgraph/orchestrator';
import type { MaintenanceEnv } from '../types.js';

/** The model an agent of the given capability tier runs on. */
export function modelFor(env: Pick<MaintenanceEnv, 'model' | 'models'>, tier: ModelTier): string {
  return env.models?.[tier] ?? env.model;
}

/**
 * The engine resolver over the env's tier map, for a workflow's runner
 * options. It resolves each agent's `modelPreference` to the same model
 * `modelFor` picked, and adds budget-aware downgrading whenever a run
 * carries a USD budget.
 */
export function tierResolver(env: Pick<MaintenanceEnv, 'model' | 'models' | 'provider'>): ModelResolver {
  return defaultModelResolver({
    high: { [env.provider]: modelFor(env, 'high') },
    medium: { [env.provider]: modelFor(env, 'medium') },
    low: { [env.provider]: modelFor(env, 'low') },
  });
}
