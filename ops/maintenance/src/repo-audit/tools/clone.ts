/**
 * clone_repo — clone, map, and cut this run's charter list.
 *
 * Clones the repository, records the head, derives scopes if none were
 * given, and schedules the charter cross-product: human-changed scopes take
 * up to half the slots, the rest fill oldest-audited-first, then the cap and
 * skip are applied. Each surviving pair becomes an {@link AuditCharter}.
 *
 * @module maintenance/repo-audit/tools/clone
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { tool } from '@cycgraph/orchestrator';
import { cloneToBranch } from '@cycgraph/tools/git';
import { repoMap } from '../../shared/repo.js';
import { maintenanceBranch } from '../../shared/context.js';
import { charterOrder, deriveScopes, LENS_BRIEFS, type AuditCharter } from '../charter.js';
import { scheduleCharters } from '../schedule.js';
import type { RepoAuditContext } from '../context.js';

const exec = promisify(execFile);

/** The clone-map-and-schedule tool, bound to the run's context. */
export function cloneTool(c: RepoAuditContext) {
  const { repoRoot, workspaceAt, params: p, maintenance, schedule, changedScopes } = c;
  return tool({
    name: 'clone_repo',
    description: 'Clone the repository, map it, and cut the charter list for this run.',
    parameters: z.object({}),
    timeoutMs: 120_000,
    execute: async () => {
      const ws = await cloneToBranch(repoRoot, maintenanceBranch(maintenance, `audit/scan-${randomUUID().slice(0, 8)}`), { at: workspaceAt });
      const { stdout: headRaw } = await exec('git', ['rev-parse', 'HEAD'], { cwd: ws.root });
      const scopes = p.scopes.length > 0 ? p.scopes : await deriveScopes(ws.root);
      const charters: AuditCharter[] = scheduleCharters(charterOrder(p.lenses, scopes), {
        changedScopes,
        schedule,
        changedSlotCap: Math.ceil(p.maxAuditors / 2),
      })
        .slice(p.skip, p.skip + p.maxAuditors)
        .map(({ lens, scope }) => ({
          lens,
          scope,
          brief: [
            LENS_BRIEFS[lens] ?? lens,
            `Your scope is ${scope}: read there, though evidence may cite any path that supports the finding.`,
            ...(p.focus !== '' ? [`Focus: ${p.focus}.`] : []),
          ].join(' '),
        }));
      return {
        workspace: ws.root,
        head: headRaw.trim(),
        charter_count: charters.length,
        charters,
        ...(changedScopes.size > 0 ? { changed_scopes: [...changedScopes] } : {}),
        map: await repoMap(ws.root, maintenance.workspaceRoots),
      };
    },
  });
}
