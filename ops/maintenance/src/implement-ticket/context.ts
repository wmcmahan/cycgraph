/**
 * The implement-ticket input schema and the resolved state its parts share.
 *
 * The agents, tools, and graph are each built by their own factory off one
 * {@link ImplementContext}. Beyond the usual repo-shaped config it carries
 * the delivery branch and a mutable `picked` holder the pick tool writes so
 * onFatal can flag the issue when an engine-level death bypasses giveup.
 *
 * @module maintenance/implement-ticket/context
 */

import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createWorkspaceSession } from '@cycgraph/tools/workspace';
import type { WorkspaceSession } from '@cycgraph/tools/workspace';
import { APPROVED_LABEL, resolveRepo } from '../shared/repo.js';
import { contextOf, maintenanceBranch, resolveStandardsBrief } from '../shared/context.js';
import type { MaintenanceContext } from '../shared/context.js';
import type { MaintenanceEnv } from '../types.js';

export const params = z.object({
  repoRoot: z.string().default('')
    .describe('Repository the feature lands in. Empty means the repository this runs inside'),
  label: z.string().default(APPROVED_LABEL)
    .describe('Only tickets carrying this label are picked up — the human approval gate'),
  issueNumber: z.number().int().min(0).default(0)
    .describe('Implement this specific ticket. Zero picks the oldest approved one'),
  ticketFile: z.string().default('')
    .describe('Detached mode: read the ticket body from this file instead of GitHub; closes nothing'),
  attempts: z.number().int().min(1).max(6).default(3)
    .describe('Implementation attempts before the run gives up; each re-runs the acceptance criteria'),
  checks: z.array(z.string()).default([])
    .describe('Commands that must pass beyond the acceptance criteria, e.g. ["npm run lint"]'),
  commit: z.boolean().default(true)
    .describe('Commit the accepted implementation. Off leaves the workspace for inspection'),
  publish: z.boolean().default(true)
    .describe('Push and open the PR. Off leaves the prepared publish script'),
  prompt: z.string().default('')
    .describe('Override the implementer agent\'s instructions'),
  budgetTokens: z.number().int().min(0).default(900000)
    .describe('Hard token budget for the run; breach fails the run. Zero removes the cap'),
});

export type Params = z.infer<typeof params>;

/** The issue the pick tool chose, held so onFatal can flag it. */
export interface PickedHolder {
  issue?: number;
}

/** The resolved state the implementer, reviewer, tools, and graph share. */
export interface ImplementContext {
  params: Params;
  env: MaintenanceEnv;
  /** The repository the feature lands in, resolved to an absolute path. */
  repoRoot: string;
  /** The repo-shaped labels, standards, branch conventions, and local-check policy. */
  maintenance: MaintenanceContext;
  /** The convention brief handed to the implementer, pointer-to-doc resolved. */
  standardsBrief: string;
  /** The fresh clone the implementation is made in. */
  workspaceAt: string;
  session: WorkspaceSession;
  /** The branch a delivered implementation commits to. */
  branchName: string;
  /** The publishing PAT, when one is configured. */
  token: string | undefined;
  /**
   * Mutable: the pick tool records the ticket's issue here. An engine-level
   * death bypasses the giveup node, so onFatal reads the issue from here to
   * flag it needs-human. Detached runs leave it unset.
   */
  picked: PickedHolder;
}

/** Resolve everything the run's parts share, once, at the top of `build`. */
export async function buildImplementContext(params: Params, env: MaintenanceEnv): Promise<ImplementContext> {
  const repoRoot = await resolveRepo(params.repoRoot);
  const maintenance = contextOf(env);
  return {
    params,
    env,
    repoRoot,
    maintenance,
    standardsBrief: await resolveStandardsBrief(repoRoot, maintenance),
    workspaceAt: join(tmpdir(), `cycgraph-feat-impl-${randomUUID()}`),
    session: createWorkspaceSession(),
    branchName: maintenanceBranch(maintenance, `feat/impl-${randomUUID().slice(0, 8)}`),
    token: env.publish?.token,
    picked: {},
  };
}
