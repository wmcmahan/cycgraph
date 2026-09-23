/**
 * run_check — the implementer's mid-edit verification.
 *
 * Lets the implementer iterate test-driven inside its turn instead of
 * editing blind and waiting for the acceptance node's verdict. Same
 * allowlist as acceptance: repository script shapes only, never arbitrary
 * programs. Wired to the implementer only when local checks are on.
 *
 * @module maintenance/implement-ticket/tools/run-check
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { tool } from '@cycgraph/orchestrator';
import { safeAcceptanceCommand } from '../../shared/proposal.js';
import { checksEnv } from '../../shared/repo.js';
import type { ImplementContext } from '../context.js';

const exec = promisify(execFile);

/** The mid-edit check-runner tool, bound to the clone. */
export function runCheckTool(c: ImplementContext) {
  const { workspaceAt } = c;
  return tool({
    name: 'run_check',
    description: 'Run one repository check command (npm test, npm run <script> [--workspace=pkg], npx vitest run [path], npx tsc --noEmit) in the workspace and see its output.',
    parameters: z.object({ command: z.string().describe('The exact command to run; must match an allowed repository script shape') }),
    timeoutMs: 960_000,
    execute: async ({ command }) => {
      const safe = safeAcceptanceCommand(command);
      if (safe === undefined) {
        return { passed: false, output: `refused: '${command}' is not an allowed repository check shape` };
      }
      try {
        const { stdout } = await exec('sh', ['-c', safe], { cwd: workspaceAt, env: checksEnv(), maxBuffer: 64 * 1024 * 1024, timeout: 900_000 });
        return { passed: true, output: String(stdout).slice(-1_500) };
      } catch (error) {
        const failed = error as { stdout?: string; stderr?: string; message?: string };
        const output = failed.stdout ?? failed.stderr ?? failed.message;
        return { passed: false, output: String(output).slice(-3_000) };
      }
    },
  });
}
