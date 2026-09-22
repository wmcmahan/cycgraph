/**
 * repo_checks — the gate's read-only pass over the revision.
 *
 * Runs the repository's own checks in the workspace and refuses tree
 * mutation: a check that writes source files, or a revision that changed
 * nothing, is a failed pass the gate loops back to the reviser. The
 * result's wording rides the retry prompt, so it says so in words rather
 * than a bare "passed".
 *
 * @module maintenance/pr-revise/tools/repo-checks
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { tool } from '@cycgraph/orchestrator';
import { changedIn } from '@cycgraph/tools/git';
import { checksEnv } from '../../shared/repo.js';
import type { ReviseContext } from '../context.js';

const exec = promisify(execFile);

/** The gate's checks tool, bound to the clone. */
export function repoChecksTool(c: ReviseContext) {
  const { workspaceAt, params: p, maintenance } = c;
  return tool({
    name: 'repo_checks',
    description: 'Run the repository\'s own checks in the workspace, refusing tree mutation.',
    parameters: z.object({}),
    timeoutMs: 1_800_000,
    execute: async () => {
      const treeBefore = (await changedIn(workspaceAt)).join('\n');
      // With local checks off (the product), no tree code runs — the gate
      // keeps only its tree-mutation guard, and CI verifies the push.
      const hasChecks = maintenance.runLocalChecks && p.checks.length > 0;

      if (hasChecks) {
        try {
          const maxBuffer = 64 * 1024 * 1024;
          await exec('sh', ['-c', p.checks.join(' && ')], { cwd: workspaceAt, env: checksEnv(), maxBuffer });
        } catch (error) {
          // Both streams, stderr first. Tools vary in where they report a failure.
          const streams = [
            String((error as { stderr?: string }).stderr ?? '').trim().slice(-3_000),
            String((error as { stdout?: string }).stdout ?? '').trim().slice(-3_000),
          ].filter((tail) => tail !== '');
          const output = streams.length > 0 ? streams.join('\n---\n') : (error as Error).message.slice(0, 3_000);
          return { clean: false, output };
        }
      }

      const mutated = (await changedIn(workspaceAt)).join('\n') !== treeBefore;

      if (mutated) {
        return {
          clean: false,
          has_changes: true,
          output: 'running the checks modified the tree — checks must not write source files',
        };
      }

      return {
        clean: true,
        has_changes: treeBefore !== '',
        output: treeBefore !== ''
          ? 'checks passed'
          : 'the tree is unchanged — the feedback has NOT been addressed; edit the files the findings name before replying',
      };
    },
  });
}
