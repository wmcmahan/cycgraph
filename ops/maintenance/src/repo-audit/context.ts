/**
 * The repo-audit input schema and the resolved state its parts share.
 *
 * Beyond the usual repo-shaped config, the context resolves the patrol
 * inputs once: the last audit schedule and the scopes a human has changed
 * since it. The clone tool reads both to cut this run's charter list.
 *
 * @module maintenance/repo-audit/context
 */

import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { DEFAULT_IDENTITY } from '@cycgraph/tools/git';
import { createWorkspaceSession } from '@cycgraph/tools/workspace';
import type { WorkspaceSession } from '@cycgraph/tools/workspace';
import { resolveRepo } from '../shared/repo.js';
import { contextOf } from '../shared/context.js';
import type { MaintenanceContext } from '../shared/context.js';
import type { MaintenanceEnv } from '../types.js';
import { changedScopesSince, LENS_BRIEFS } from './charter.js';
import type { AuditSchedule } from './schedule.js';

export const params = z.object({
  repoRoot: z.string().default('')
    .describe('Repository to audit. Empty means the repository this runs inside'),
  lenses: z.array(z.string()).default(Object.keys(LENS_BRIEFS))
    .describe('Audit lenses to apply. Names outside the built-in set are passed to auditors as literal charters'),
  scopes: z.array(z.string()).default([])
    .describe('Repository paths to audit, e.g. ["packages/orchestrator"]. Empty derives one scope per workspace package'),
  maxAuditors: z.number().int().min(1).max(32).default(12)
    .describe('Charters fanned out in one run; the lens × scope cross-product is capped to this'),
  skip: z.number().int().min(0).default(0)
    .describe('Charters to skip, so a later run rotates onto the next slice of the cross-product'),
  concurrency: z.number().int().min(1).max(8).default(4)
    .describe('Auditors in flight at once'),
  steps: z.number().int().min(8).max(50).default(48)
    .describe('Tool-call steps each auditor may spend before it must report'),
  maxFindings: z.number().int().min(1).max(20).default(5)
    .describe('Findings filed per run after ranking'),
  file: z.boolean().default(true)
    .describe('File the shortlist as issues. Off reports the sift verdict only'),
  approve: z.boolean().default(false)
    .describe('File tickets carrying the maintenance-approved label, feeding the automated fix queue without a human labeling step. The human gates that remain are the PR and the ability to unlabel'),
  focus: z.string().default('')
    .describe('Steer every charter toward an area or concern. Empty leaves charters as lens × scope'),
  prompt: z.string().default('')
    .describe('Override the auditor agent\'s instructions. A config knob so the tune loop can sweep it'),
  budgetTokens: z.number().int().min(0).default(6_000_000)
    .describe('Hard token budget for the run; zero removes the cap. The fan-out stops dispatching auditors as the budget nears, so a tight budget trims the charter list rather than failing the run. Sized from a measured full run: ~4.15M billed for 12 deep auditors with partial cache hits'),
});

export type Params = z.infer<typeof params>;

/** The resolved state the auditor, tools, and graph share. */
export interface RepoAuditContext {
  params: Params;
  env: MaintenanceEnv;
  /** The repository being audited, resolved to an absolute path. */
  repoRoot: string;
  /** The repo-shaped labels, markers, workspace roots, and branch conventions. */
  maintenance: MaintenanceContext;
  /** The fresh clone the auditors read. */
  workspaceAt: string;
  session: WorkspaceSession;
  /** The publishing PAT, when one is configured. */
  token: string | undefined;
  /** The last recorded audit schedule, or undefined without a lesson store. */
  schedule: AuditSchedule | undefined;
  /** Scopes a human has changed since the last audited head (biases the charter cut). */
  changedScopes: Set<string>;
}

/** Resolve everything the run's parts share, once, at the top of `build`. */
export async function buildRepoAuditContext(params: Params, env: MaintenanceEnv): Promise<RepoAuditContext> {
  const repoRoot = await resolveRepo(params.repoRoot);
  const maintenance = contextOf(env);
  // Patrol scheduling: human-changed scopes take up to half the slots, the
  // rest of the cross-product fills oldest-audited-first. With no recorded
  // state both inputs are empty and the diagonal order stands.
  const schedule = await env.auditSchedule?.load();
  const botAuthors = new Set([
    DEFAULT_IDENTITY.name,
    ...(env.publish?.identity?.name !== undefined ? [env.publish.identity.name] : []),
  ]);
  return {
    params,
    env,
    repoRoot,
    maintenance,
    workspaceAt: join(tmpdir(), `cycgraph-audit-${randomUUID()}`),
    session: createWorkspaceSession(),
    token: env.publish?.token,
    schedule,
    changedScopes: await changedScopesSince(repoRoot, schedule?.head, botAuthors),
  };
}
