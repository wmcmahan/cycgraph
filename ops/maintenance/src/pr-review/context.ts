/**
 * The pr-review input schema and the resolved state its parts share.
 *
 * The agents, tools, and graph are each built by their own factory, and
 * every one closes over the same handful of values: the params, the
 * environment, the repository and the fresh clone the review reads, the
 * standards brief, and the publishing token. `ReviewContext` bundles them
 * so a factory takes one argument, and `buildReviewContext` resolves it
 * once at the top of `build`.
 *
 * @module maintenance/pr-review/context
 */

import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createWorkspaceSession } from '@cycgraph/tools/workspace';
import type { WorkspaceSession } from '@cycgraph/tools/workspace';
import { contextOf, resolveStandardsBrief } from '../shared/context.js';
import type { MaintenanceContext } from '../shared/context.js';
import { DEFAULT_BASE_BRANCH, resolveRepo } from '../shared/repo.js';
import type { MaintenanceEnv } from '../types.js';

export const params = z.object({
  repoRoot: z.string().default('')
    .describe('Repository the pull request belongs to. Empty means the repository this runs inside'),
  pr: z.number().int().min(1)
    .describe('The pull request to review'),
  base: z.string().default(DEFAULT_BASE_BRANCH)
    .describe('The branch the PR merges into; the review covers the diff against it'),
  comment: z.boolean().default(true)
    .describe('Post the review as a PR comment. Off prints it to the run state only'),
  revise: z.boolean().default(true)
    .describe('On a REVISE verdict against a PR carrying the maintenance-managed label, end the comment with an @cycgraph trigger so pr-revise addresses the findings. Unlabeled PRs get findings only. Needs the comment posted via a PAT — the Actions token\'s comments fire no workflows'),
  merge: z.boolean().default(false)
    .describe('On an APPROVE verdict against a PR carrying the maintenance-managed label, enable auto-merge (squash, branch deleted) so the PR merges once its checks pass. The human gate becomes stopping it: disable auto-merge, unlabel, or close the PR'),
  prompt: z.string().default('')
    .describe('Override the reviewer agent\'s instructions'),
  budgetTokens: z.number().int().min(0).default(400000)
    .describe('Hard token budget for the run; breach fails the run. Zero removes the cap'),
});

export type Params = z.infer<typeof params>;

/** The resolved state the reviewer agents, tools, and graph share. */
export interface ReviewContext {
  params: Params;
  env: MaintenanceEnv;
  /** The repository the PR belongs to, resolved to an absolute path. */
  repoRoot: string;
  /** The repo-shaped labels, standards, and branch conventions. */
  maintenance: MaintenanceContext;
  /** The convention brief handed to the reviewer, pointer-to-doc resolved. */
  standardsBrief: string;
  /** The fresh clone the PR branch is read in, checked out by `gather_pr`. */
  workspaceAt: string;
  session: WorkspaceSession;
  /** The publishing PAT, when one is configured; reading works without it. */
  token: string | undefined;
}

/** Resolve everything the run's parts share, once, at the top of `build`. */
export async function buildReviewContext(params: Params, env: MaintenanceEnv): Promise<ReviewContext> {
  const repoRoot = await resolveRepo(params.repoRoot);
  const maintenance = contextOf(env);
  return {
    params,
    env,
    repoRoot,
    maintenance,
    standardsBrief: await resolveStandardsBrief(repoRoot, maintenance),
    workspaceAt: join(tmpdir(), `cycgraph-pr-review-${randomUUID()}`),
    session: createWorkspaceSession(),
    token: env.publish?.token,
  };
}
