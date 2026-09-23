/**
 * The docs-maintenance input schema, its scenario options, and the resolved
 * state its parts share.
 *
 * `docsMaintenance(options)` is one parameterized workflow; the two
 * registered variants (`repoDocsMaintenance`, `websiteDocsMaintenance`) are
 * it with a scope. Beyond the usual config the context carries the resolved
 * scenario `id`, the `options` the scan is scoped by, the delivery branch,
 * and a mutable `scan` holder: the open-PR claim set and diff-mode changed
 * paths are fetched once per run and shared between the scan and judge
 * tools.
 *
 * @module maintenance/docs/context
 */

import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createWorkspaceSession } from '@cycgraph/tools/workspace';
import type { WorkspaceSession } from '@cycgraph/tools/workspace';
import { resolveRepo } from '../shared/repo.js';
import { contextOf, maintenanceBranch } from '../shared/context.js';
import type { MaintenanceContext } from '../shared/context.js';
import type { MaintenanceEnv } from '../types.js';

export const params = z.object({
  repoRoot: z.string().default('')
    .describe('Repository whose documentation is maintained. Empty means the repository this runs inside'),
  checks: z.array(z.string()).default([])
    .describe('Commands that must pass before a fix may be committed, e.g. ["npm run lint"]'),
  skip: z.number().int().min(0).default(0)
    .describe('Findings to skip, so a second run can take the next one'),
  commit: z.boolean().default(true)
    .describe('Commit the verified fix to a branch. Off leaves the workspace for inspection'),
  publish: z.boolean().default(true)
    .describe('Push the committed branch to origin and open a pull request. Off leaves the prepared publish script in the commit result'),
  prompt: z.string().default('')
    .describe('Override the fixer agent\'s instructions. Empty uses the built-in prompt. A config knob so the tune loop can sweep it'),
  attempts: z.number().int().min(1).max(6).default(3)
    .describe('Fix attempts per finding before it is abandoned and the run moves to the next one'),
  batch: z.number().int().min(1).max(10).default(1)
    .describe('Findings to fix in one run: one branch, one commit per verified fix, one pull request'),
  since: z.string().default('')
    .describe('Diff mode: a git ref. Only findings a change since that ref plausibly staled are taken'),
  budgetTokens: z.number().int().min(0).default(400000)
    .describe('Hard token budget for the run; breach fails the run. Zero removes the cap'),
});

export type Params = z.infer<typeof params>;

/** Configuration that splits the docs family into thin scenarios. */
export interface DocsMaintenanceOptions {
  id?: string;
  title?: string;
  /** Scan only documents under these paths. Empty scans everywhere. */
  roots?: string[];
  /** Never scan documents under these paths. */
  exclude?: string[];
}

/**
 * Per-run scan state, fetched once and shared by the scan and judge tools:
 * the open-`docs/`-PR claim set and, in diff mode, the paths changed since
 * `--since`. Neither moves mid-run.
 */
export interface DocsScanState {
  deferredFetched: boolean;
  deferred?: string[];
  changed?: string[];
}

/** The resolved state the fixer, tools, and graph share. */
export interface DocsContext {
  params: Params;
  env: MaintenanceEnv;
  /** The repository being maintained, resolved to an absolute path. */
  repoRoot: string;
  /** The repo-shaped labels, branch conventions, and local-check policy. */
  maintenance: MaintenanceContext;
  /** The fresh clone the fix is made in. */
  workspaceAt: string;
  session: WorkspaceSession;
  /** The publishing PAT, when one is configured. */
  token: string | undefined;
  /** The resolved scenario id (fix-repo-docs, fix-website-docs, or the default). */
  id: string;
  /** The scan scope for this scenario. */
  options: DocsMaintenanceOptions;
  /** The branch a delivered fix commits to. */
  branchName: string;
  /** Mutable per-run scan state, shared by the scan and judge tools. */
  scan: DocsScanState;
}

/** Resolve everything the run's parts share, once, at the top of `build`. */
export async function buildDocsContext(
  options: DocsMaintenanceOptions,
  params: Params,
  env: MaintenanceEnv,
): Promise<DocsContext> {
  const repoRoot = await resolveRepo(params.repoRoot);
  const maintenance = contextOf(env);
  const id = options.id ?? 'docs-maintenance';
  return {
    params,
    env,
    repoRoot,
    maintenance,
    workspaceAt: join(tmpdir(), `cycgraph-docs-${randomUUID()}`),
    session: createWorkspaceSession(),
    token: env.publish?.token,
    id,
    options,
    branchName: maintenanceBranch(maintenance, `docs/${id}-${randomUUID().slice(0, 8)}`),
    scan: { deferredFetched: false },
  };
}
