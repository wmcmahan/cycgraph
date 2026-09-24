/**
 * Per-tier model selection for maintenance agents.
 *
 * A `MaintenanceEnv` carries one required `model` and an optional
 * `models` tier map. Each agent declares the capability tier its role
 * needs and resolves it here, so a single-model environment runs every
 * agent on `env.model` exactly as it did before the map existed.
 *
 * @module maintenance/shared/models
 */

import type { ModelTier } from '@cycgraph/orchestrator';
import type { MaintenanceEnv } from '../types.js';

/** The model an agent of the given capability tier runs on. */
export function modelFor(env: Pick<MaintenanceEnv, 'model' | 'models'>, tier: ModelTier): string {
  return env.models?.[tier] ?? env.model;
}
