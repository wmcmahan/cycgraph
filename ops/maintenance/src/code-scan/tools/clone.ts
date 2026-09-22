/**
 * clone_repo — clone the repository into a disposable workspace.
 *
 * @module maintenance/code-scan/tools/clone
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { tool } from '@cycgraph/orchestrator';
import { cloneToBranch } from '@cycgraph/tools/git';
import { maintenanceBranch } from '../../shared/context.js';
import type { CodeScanContext } from '../context.js';

/** The clone tool, bound to the run's context. */
export function cloneTool(c: CodeScanContext) {
  const { repoRoot, workspaceAt, maintenance } = c;
  return tool({
    name: 'clone_repo',
    description: 'Clone the repository into a disposable workspace.',
    parameters: z.object({}),
    execute: async () => {
      const ws = await cloneToBranch(repoRoot, maintenanceBranch(maintenance, `upkeep/scan-${randomUUID().slice(0, 8)}`), { at: workspaceAt });
      return { workspace: ws.root };
    },
  });
}
