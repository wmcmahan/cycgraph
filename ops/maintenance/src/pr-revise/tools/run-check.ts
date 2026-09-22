/**
 * run_check — the agent's mid-edit verification.
 *
 * One repository check command, run in the workspace, refused unless it
 * matches an allowed check shape. It lets the reviser confirm a fix with
 * the repository's own commands before writing its reply.
 *
 * @module maintenance/pr-revise/tools/run-check
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { tool } from '@cycgraph/orchestrator';
import { safeAcceptanceCommand } from '../../shared/proposal.js';
import { checksEnv } from '../../shared/repo.js';
import type { ReviseContext } from '../context.js';

const exec = promisify(execFile);

/** The mid-edit check-runner tool, bound to the clone. */
export function runCheckTool(c: ReviseContext) {
  const { workspaceAt } = c;
  return tool({
    name: 'run_check',
    description: 'Run one repository check command (npm test, npm run <script> [--workspace=pkg], npx vitest run [path], npx tsc --noEmit) in the workspace and see its output.',
    parameters: z.object({
      command: z.string().describe('The exact command to run; must match an allowed repository check shape')
    }),
    timeoutMs: 960_000,
    execute: async ({ command }) => {
      const acceptedCommand = safeAcceptanceCommand(command);

      if (acceptedCommand === undefined) {
        return {
          passed: false,
          output: `refused: '${command}' is not an allowed repository check shape`,
        };
      }

      try {
        const maxBuffer = 64 * 1024 * 1024;
        const timeout = 900_000;
        const { stdout } = await exec('sh', ['-c', acceptedCommand], { cwd: workspaceAt, env: checksEnv(), maxBuffer, timeout });
        return {
          passed: true,
          output: String(stdout).slice(-1_500),
        };
      } catch (error) {
        const failed = error as { stdout?: string; stderr?: string; message?: string };
        const output = failed.stdout ?? failed.stderr ?? failed.message;
        return {
          passed: false,
          output: String(output).slice(-3_000),
        };
      }
    },
  });
}
