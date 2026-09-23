/**
 * The code-scan input schema and the resolved state its parts share.
 *
 * This workflow is mechanical — no agent — so the context carries the
 * clone, the token, and the repo-shaped labels and markers the triage
 * step files and dedupes against.
 *
 * @module maintenance/code-scan/context
 */

import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { resolveRepo } from '../shared/repo.js';
import { contextOf } from '../shared/context.js';
import type { MaintenanceContext } from '../shared/context.js';
import type { MaintenanceEnv } from '../types.js';

export const params = z.object({
  repoRoot: z.string().default('')
    .describe('Repository whose upkeep is sensed. Empty means the repository this runs inside'),
  maxIssues: z.number().int().min(1).max(10).default(3)
    .describe('New issues to file in one run'),
  lint: z.boolean().default(true)
    .describe('Include the eslint sense class. Off keeps a run to the cheap grep classes'),
  file: z.boolean().default(true)
    .describe('File the issues. Off reports what would be filed and touches nothing'),
  approve: z.boolean().default(false)
    .describe('File issues carrying the maintenance-approved label, feeding the automated fix queue without a human labeling step'),
});

export type Params = z.infer<typeof params>;

/** The resolved state the tools and graph share. */
export interface CodeScanContext {
  params: Params;
  env: MaintenanceEnv;
  /** The repository being sensed, resolved to an absolute path. */
  repoRoot: string;
  /** The repo-shaped labels, markers, and branch conventions. */
  maintenance: MaintenanceContext;
  /** The fresh clone the scan runs against. */
  workspaceAt: string;
  /** The publishing PAT, when one is configured. */
  token: string | undefined;
}

/** Resolve everything the run's parts share, once, at the top of `build`. */
export async function buildCodeScanContext(params: Params, env: MaintenanceEnv): Promise<CodeScanContext> {
  return {
    params,
    env,
    repoRoot: await resolveRepo(params.repoRoot),
    maintenance: contextOf(env),
    workspaceAt: join(tmpdir(), `cycgraph-upkeep-${randomUUID()}`),
    token: env.publish?.token,
  };
}
