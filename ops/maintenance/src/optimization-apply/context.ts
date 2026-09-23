/**
 * The optimization-apply input schema and the resolved state its parts share.
 *
 * This workflow is mechanical — no agent — so the context carries the
 * clone, the delivery branch, the token, and a mutable `picked` holder the
 * pick tool writes so onFatal can flag the issue when an engine-level death
 * bypasses the give_up node.
 *
 * @module maintenance/optimization-apply/context
 */

import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { APPROVED_LABEL, resolveRepo } from '../shared/repo.js';
import { contextOf, maintenanceBranch } from '../shared/context.js';
import type { MaintenanceContext } from '../shared/context.js';
import type { MaintenanceEnv } from '../types.js';

export const params = z.object({
  repoRoot: z.string().default('')
    .describe('Repository the optimization lands in. Empty means the repository this runs inside'),
  label: z.string().default(APPROVED_LABEL)
    .describe('Only tickets carrying this label are picked up — the human approval gate'),
  issueNumber: z.number().int().min(0).default(0)
    .describe('Apply this specific ticket. Zero picks the oldest approved one'),
  ticketFile: z.string().default('')
    .describe('Detached mode: read the ticket body from this file instead of GitHub; closes nothing'),
  target: z.string().default('')
    .describe('Vitest bench file filter for the re-measurement. Empty benches everything'),
  minImprovement: z.number().min(1).max(90).default(10)
    .describe('Percent improvement the re-measurement must still show'),
  checks: z.array(z.string()).default([])
    .describe('Commands that must pass before the PR, e.g. ["npm run lint"]'),
  commit: z.boolean().default(true)
    .describe('Commit the verified change. Off leaves the workspace for inspection'),
  publish: z.boolean().default(true)
    .describe('Push and open the PR. Off leaves the prepared publish script'),
});

export type Params = z.infer<typeof params>;

/** The issue the pick tool chose, held so onFatal can flag it. */
export interface PickedHolder {
  issue?: number;
}

/** The resolved state the tools and graph share. */
export interface OptApplyContext {
  params: Params;
  env: MaintenanceEnv;
  /** The repository the optimization lands in, resolved to an absolute path. */
  repoRoot: string;
  /** The repo-shaped labels, markers, and branch conventions. */
  maintenance: MaintenanceContext;
  /** The fresh clone the diff is re-applied and re-benched in. */
  workspaceAt: string;
  /** The branch a delivered change commits to. */
  branchName: string;
  /** The publishing PAT, when one is configured. */
  token: string | undefined;
  /**
   * Mutable: the pick tool records the ticket's issue here. An engine-level
   * death bypasses the give_up node, so onFatal reads the issue from here to
   * flag it needs-human. Detached runs leave it unset.
   */
  picked: PickedHolder;
}

/** Resolve everything the run's parts share, once, at the top of `build`. */
export async function buildOptApplyContext(params: Params, env: MaintenanceEnv): Promise<OptApplyContext> {
  const maintenance = contextOf(env);
  return {
    params,
    env,
    repoRoot: await resolveRepo(params.repoRoot),
    maintenance,
    workspaceAt: join(tmpdir(), `cycgraph-optimization-apply-${randomUUID()}`),
    branchName: maintenanceBranch(maintenance, `opt/apply-${randomUUID().slice(0, 8)}`),
    token: env.publish?.token,
    picked: {},
  };
}
