/**
 * The tune input schema and the resolved state its parts share.
 *
 * The analyst, tools, and graph are each built by their own factory off one
 * {@link TuneContext}. The analyst's hands read the real repository source
 * (not a clone) to locate the instruction text to edit; the trial tool
 * clones internally.
 *
 * @module maintenance/tune/context
 */

import { z } from 'zod';
import { createWorkspaceSession } from '@cycgraph/tools/workspace';
import type { WorkspaceSession } from '@cycgraph/tools/workspace';
import { resolveRepo } from '../shared/repo.js';
import { contextOf } from '../shared/context.js';
import type { MaintenanceContext } from '../shared/context.js';
import type { MaintenanceEnv } from '../types.js';

export const params = z.object({
  repoRoot: z.string().default('')
    .describe('Repository whose maintenance source is tuned. Empty means the repository this runs inside'),
  target: z.enum(['fix-repo-docs', 'fix-website-docs', 'repo-audit', 'feature-propose']).default('fix-repo-docs')
    .describe('The workflow whose prompts the tune run studies and trials'),
  trials: z.number().int().min(2).max(8).default(3)
    .describe('Dry runs per arm (control and variant). Small samples: the ticket carries the caveat and the human judges'),
  attempts: z.number().int().min(1).max(3).default(2)
    .describe('Proposal attempts before the run exits with no proposal'),
  file: z.boolean().default(true)
    .describe('File a winning proposal as a ticket. Off reports what would be filed'),
  prompt: z.string().default('')
    .describe('Override the analyst agent\'s instructions'),
  budgetTokens: z.number().int().min(0).default(500000)
    .describe('Hard token budget for the tune graph itself (trials are subprocesses, capped by their own flags). Zero removes the cap'),
});

export type Params = z.infer<typeof params>;

/** The subtree the tune loop's proposed edits must stay inside. */
export const TUNE_SOURCE_DIR = 'ops/maintenance/src';

/** The resolved state the analyst, tools, and graph share. */
export interface TuneContext {
  params: Params;
  env: MaintenanceEnv;
  /** The repository being tuned, resolved to an absolute path. */
  repoRoot: string;
  /** The repo-shaped labels and markers. */
  maintenance: MaintenanceContext;
  session: WorkspaceSession;
  /** The publishing PAT, when one is configured. */
  token: string | undefined;
  /** The subtree a proposed edit must stay inside (`ops/maintenance/src`). */
  sourceDir: string;
}

/** Resolve everything the run's parts share, once, at the top of `build`. */
export async function buildTuneContext(params: Params, env: MaintenanceEnv): Promise<TuneContext> {
  return {
    params,
    env,
    repoRoot: await resolveRepo(params.repoRoot),
    maintenance: contextOf(env),
    session: createWorkspaceSession(),
    token: env.publish?.token,
    sourceDir: TUNE_SOURCE_DIR,
  };
}
