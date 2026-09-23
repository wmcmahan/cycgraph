/**
 * The feature-propose input schema and the resolved state its parts share.
 *
 * The surveyor, drafter, tools, and graph are each built by their own
 * factory off one {@link FeatProposeContext}, resolved once at the top of
 * `build`.
 *
 * @module maintenance/feature-propose/context
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
    .describe('Repository the feature is proposed for. Empty means the repository this runs inside'),
  focus: z.string().default('')
    .describe('Steer the proposal toward an area or goal, e.g. "authoring ergonomics". Empty lets the agent choose'),
  attempts: z.number().int().min(1).max(6).default(2)
    .describe('Proposal attempts before the run gives up'),
  file: z.boolean().default(true)
    .describe('File the proposal as an issue. Off reports the proposal and verdict only'),
  prompt: z.string().default('')
    .describe('Override the proposer agent\'s instructions'),
  budgetTokens: z.number().int().min(0).default(200000)
    .describe('Hard token budget for the run; breach fails the run. Zero removes the cap'),
});

export type Params = z.infer<typeof params>;

/** The resolved state the surveyor, drafter, tools, and graph share. */
export interface FeatProposeContext {
  params: Params;
  env: MaintenanceEnv;
  /** The repository being surveyed, resolved to an absolute path. */
  repoRoot: string;
  /** The repo-shaped labels, markers, workspace roots, and branch conventions. */
  maintenance: MaintenanceContext;
  /** The fresh clone the survey reads. */
  workspaceAt: string;
  session: WorkspaceSession;
  /** The publishing PAT, when one is configured. */
  token: string | undefined;
}

/** Resolve everything the run's parts share, once, at the top of `build`. */
export async function buildFeatProposeContext(params: Params, env: MaintenanceEnv): Promise<FeatProposeContext> {
  return {
    params,
    env,
    repoRoot: await resolveRepo(params.repoRoot),
    maintenance: contextOf(env),
    workspaceAt: join(tmpdir(), `cycgraph-feat-${randomUUID()}`),
    session: createWorkspaceSession(),
    token: env.publish?.token,
  };
}
