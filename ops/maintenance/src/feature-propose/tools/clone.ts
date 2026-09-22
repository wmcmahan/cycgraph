/**
 * clone_repo — clone the repository and map it, so surveying starts oriented.
 *
 * A deterministic map costs no model tokens to produce and is read once,
 * replacing the many search calls a blind survey spends discovering the
 * same structure every run.
 *
 * @module maintenance/feature-propose/tools/clone
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { tool } from '@cycgraph/orchestrator';
import { cloneToBranch } from '@cycgraph/tools/git';
import { repoMap } from '../../shared/repo.js';
import { maintenanceBranch } from '../../shared/context.js';
import type { FeatProposeContext } from '../context.js';

/** The clone-and-map tool, bound to the run's context. */
export function cloneTool(c: FeatProposeContext) {
  const { repoRoot, workspaceAt, maintenance } = c;
  return tool({
    name: 'clone_repo',
    description: 'Clone the repository and map it, so surveying starts oriented.',
    parameters: z.object({}),
    timeoutMs: 120_000,
    execute: async () => {
      const ws = await cloneToBranch(repoRoot, maintenanceBranch(maintenance, `feat/scan-${randomUUID().slice(0, 8)}`), { at: workspaceAt });
      return { workspace: ws.root, map: await repoMap(ws.root, maintenance.workspaceRoots) };
    },
  });
}
