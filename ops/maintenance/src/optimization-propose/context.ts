/**
 * The optimization-propose input schema and the resolved state its parts share.
 *
 * The optimizer, tools, and graph are each built by their own factory off
 * one {@link OptProposeContext}, resolved once at the top of `build`.
 *
 * @module maintenance/optimization-propose/context
 */

import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createWorkspaceSession } from '@cycgraph/tools/workspace';
import type { WorkspaceSession } from '@cycgraph/tools/workspace';
import { resolveRepo } from '../shared/repo.js';
import { contextOf } from '../shared/context.js';
import type { MaintenanceContext } from '../shared/context.js';
import type { MaintenanceEnv } from '../types.js';

export const params = z.object({
  repoRoot: z.string().default('')
    .describe('Repository whose hot paths are optimized. Empty means the repository this runs inside'),
  target: z.string().default('')
    .describe('Vitest bench file filter, e.g. "reducer". Empty benches everything'),
  minImprovement: z.number().min(1).max(90).default(10)
    .describe('Percent throughput improvement a proposal must measure to be worth a ticket'),
  scope: z.string().default('packages/orchestrator/src')
    .describe('Directory the optimization may touch; changes outside it are refused'),
  checks: z.array(z.string()).default([])
    .describe('Commands that must pass before a proposal may be filed, e.g. ["npm run lint"]'),
  attempts: z.number().int().min(1).max(8).default(3)
    .describe('Optimization attempts before the run gives up; each re-benches'),
  file: z.boolean().default(true)
    .describe('File the verified proposal as an issue. Off reports the verdict and diff only'),
  prompt: z.string().default('')
    .describe('Override the optimizer agent\'s instructions'),
  budgetTokens: z.number().int().min(0).default(400000)
    .describe('Hard token budget for the run; breach fails the run. Zero removes the cap'),
});

export type Params = z.infer<typeof params>;

/** The resolved state the optimizer, tools, and graph share. */
export interface OptProposeContext {
  params: Params;
  env: MaintenanceEnv;
  /** The repository being optimized, resolved to an absolute path. */
  repoRoot: string;
  /** The repo-shaped labels, markers, and branch conventions. */
  maintenance: MaintenanceContext;
  /** The fresh clone the optimization is measured and made in. */
  workspaceAt: string;
  session: WorkspaceSession;
  /** The publishing PAT, when one is configured. */
  token: string | undefined;
}

/** Resolve everything the run's parts share, once, at the top of `build`. */
export async function buildOptProposeContext(params: Params, env: MaintenanceEnv): Promise<OptProposeContext> {
  return {
    params,
    env,
    repoRoot: await resolveRepo(params.repoRoot),
    maintenance: contextOf(env),
    workspaceAt: join(tmpdir(), `cycgraph-opt-${randomUUID()}`),
    session: createWorkspaceSession(),
    token: env.publish?.token,
  };
}
