/**
 * repo_checks — the gate's check run over the re-applied change.
 *
 * Off in the product (`runLocalChecks` false) and when no checks are
 * configured: it passes without running tree code, and CI is the gate.
 *
 * @module maintenance/optimization-apply/tools/checks
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { tool } from '@cycgraph/orchestrator';
import { checksEnv } from '../../shared/repo.js';
import type { OptApplyContext } from '../context.js';

const exec = promisify(execFile);

/** The repo_checks tool, bound to the clone. */
export function checksTool(c: OptApplyContext) {
  const { workspaceAt, params: p, maintenance } = c;
  return tool({
    name: 'repo_checks',
    description: 'Run the repository\'s own checks in the workspace.',
    parameters: z.object({}),
    timeoutMs: 1_200_000,
    execute: async () => {
      if (!maintenance.runLocalChecks) return { clean: true, output: 'local checks off; the repository\'s CI is the gate' };
      if (p.checks.length === 0) return { clean: true, output: 'no checks configured' };
      try {
        await exec('sh', ['-c', p.checks.join(' && ')], { cwd: workspaceAt, env: checksEnv(), maxBuffer: 64 * 1024 * 1024 });
        return { clean: true, output: 'checks passed' };
      } catch (error) {
        return { clean: false, output: String((error as { stdout?: string }).stdout ?? (error as Error).message).slice(-2_000) };
      }
    },
  });
}
