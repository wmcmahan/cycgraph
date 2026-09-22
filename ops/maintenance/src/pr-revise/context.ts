/**
 * The pr-revise input schema and the resolved state its parts share.
 *
 * The agent, tools, and graph are each built by their own factory, and
 * every one closes over the same handful of values: the params, the
 * environment, the repository and the fresh clone the revision happens
 * in, the standards brief, and the publishing token. `ReviseContext`
 * bundles them so a factory takes one argument, and `buildReviseContext`
 * resolves it once at the top of `build`.
 *
 * @module maintenance/pr-revise/context
 */

import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createWorkspaceSession } from '@cycgraph/tools/workspace';
import type { WorkspaceSession } from '@cycgraph/tools/workspace';
import { contextOf, resolveStandardsBrief } from '../shared/context.js';
import type { MaintenanceContext } from '../shared/context.js';
import { resolveRepo } from '../shared/repo.js';
import type { MaintenanceEnv } from '../types.js';

export const params = z.object({
  repoRoot: z.string().default('')
    .describe('Repository the pull request belongs to. Empty means the repository this runs inside'),
  pr: z.number().int().min(1)
    .describe('The pull request whose review feedback is addressed'),
  checks: z.array(z.string()).default([])
    .describe('Commands that must pass before the revision is pushed, e.g. ["npm run lint:eslint"]'),
  attempts: z.number().int().min(1).max(4).default(2)
    .describe('Revision attempts before the run gives up'),
  push: z.boolean().default(true)
    .describe('Push the revision to the PR branch and reply. Off leaves the workspace for inspection'),
  prompt: z.string().default('')
    .describe('Override the reviser agent\'s instructions'),
  budgetTokens: z.number().int().min(0).default(400000)
    .describe('Hard token budget for the run; breach fails the run. Zero removes the cap'),
});

export type Params = z.infer<typeof params>;

/** The resolved state the reviser agent, tools, and graph share. */
export interface ReviseContext {
  params: Params;
  env: MaintenanceEnv;
  /** The repository the PR belongs to, resolved to an absolute path. */
  repoRoot: string;
  /** The repo-shaped labels, standards, and branch conventions. */
  maintenance: MaintenanceContext;
  /** The convention brief handed to the reviser, pointer-to-doc resolved. */
  standardsBrief: string;
  /** The fresh clone the revision is made in, checked out to the PR branch. */
  workspaceAt: string;
  session: WorkspaceSession;
  /** The publishing PAT, when one is configured; commenting works without it. */
  token: string | undefined;
}

/** Resolve everything the run's parts share, once, at the top of `build`. */
export async function buildReviseContext(params: Params, env: MaintenanceEnv): Promise<ReviseContext> {
  const repoRoot = await resolveRepo(params.repoRoot);
  const maintenance = contextOf(env);
  return {
    params,
    env,
    repoRoot,
    maintenance,
    standardsBrief: await resolveStandardsBrief(repoRoot, maintenance),
    workspaceAt: join(tmpdir(), `cycgraph-pr-revise-${randomUUID()}`),
    session: createWorkspaceSession(),
    token: env.publish?.token,
  };
}
