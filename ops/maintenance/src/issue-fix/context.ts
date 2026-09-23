/**
 * The issue-fix input schema and the resolved state its parts share.
 *
 * The agents, tools, and graph are each built by their own factory off one
 * {@link IssueFixContext}, resolved once at the top of `build`. Beyond the
 * usual repo-shaped config it carries two run-scoped values: the branch a
 * delivered fix commits to, and a mutable `picked` holder the pick tool
 * writes so `onFatal` can flag the issue when an engine-level death
 * bypasses the give_up node.
 *
 * @module maintenance/issue-fix/context
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
    .describe('Repository whose approved upkeep is fixed. Empty means the repository this runs inside'),
  label: z.string().default(APPROVED_LABEL)
    .describe('Only issues carrying this label are picked up — the human approval gate'),
  issueNumber: z.number().int().min(0).default(0)
    .describe('Fix this specific issue. Zero picks the oldest approved one'),
  key: z.string().default('')
    .describe('Detached mode: fix this finding key directly, without reading or closing any issue'),
  ticketFile: z.string().default('')
    .describe('The issue body backing a detached --key, read from this file. Required for `audit:` keys'),
  checks: z.array(z.string()).default([])
    .describe('Commands that must pass before a fix may be committed, e.g. ["npm run lint"]'),
  lint: z.boolean().default(true)
    .describe('Include the eslint sense class in the baseline and judge scans'),
  commit: z.boolean().default(true)
    .describe('Commit the verified fix to a branch. Off leaves the workspace for inspection'),
  publish: z.boolean().default(true)
    .describe('Push the committed branch to origin and open a pull request'),
  prompt: z.string().default('')
    .describe('Override the fixer agent\'s instructions. Empty uses the built-in prompt'),
  budgetTokens: z.number().int().min(0).default(1_500_000)
    .describe('Hard token budget for the run; breach fails the run. Zero removes the cap'),
});

export type Params = z.infer<typeof params>;

/** The issue the pick tool chose, held so onFatal can flag it. */
export interface PickedHolder {
  issue?: number;
}

/** The resolved state the fixer, reviewer, tools, and graph share. */
export interface IssueFixContext {
  params: Params;
  env: MaintenanceEnv;
  /** The repository being maintained, resolved to an absolute path. */
  repoRoot: string;
  /** The repo-shaped labels, standards, and branch conventions. */
  maintenance: MaintenanceContext;
  /** The convention brief handed to the fixer, pointer-to-doc resolved. */
  standardsBrief: string;
  /** The fresh clone the fix is made in. */
  workspaceAt: string;
  session: WorkspaceSession;
  /** The branch a delivered fix commits to. */
  branchName: string;
  /** The publishing PAT, when one is configured. */
  token: string | undefined;
  /**
   * Mutable: the pick tool records the issue it chose here. An engine-level
   * death (budget breach) never reaches the give_up node, and the state it
   * would have read dies with the run — so onFatal reads the issue from here
   * to flag it needs-human. Detached runs leave it unset.
   */
  picked: PickedHolder;
}

/** Resolve everything the run's parts share, once, at the top of `build`. */
export async function buildIssueFixContext(params: Params, env: MaintenanceEnv): Promise<IssueFixContext> {
  const repoRoot = await resolveRepo(params.repoRoot);
  const maintenance = contextOf(env);
  return {
    params,
    env,
    repoRoot,
    maintenance,
    standardsBrief: await resolveStandardsBrief(repoRoot, maintenance),
    workspaceAt: join(tmpdir(), `cycgraph-issue-fix-${randomUUID()}`),
    session: createWorkspaceSession(),
    branchName: maintenanceBranch(maintenance, `upkeep/fix-${randomUUID().slice(0, 8)}`),
    token: env.publish?.token,
    picked: {},
  };
}
