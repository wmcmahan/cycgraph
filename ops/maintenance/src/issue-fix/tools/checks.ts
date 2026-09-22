/**
 * The repository check tools: the gate's full run and the fixer's probe.
 *
 * `repo_checks` runs the full check trio at the gate; `workspace_check` is
 * a fast subset — the first check command — the fixer runs mid-edit, so it
 * does not fail the gate blind. Both are off in the product (`runLocalChecks`
 * false) and when no checks are configured: they run `true`, a no-op that
 * always passes, and CI becomes the gate.
 *
 * @module maintenance/issue-fix/tools/checks
 */

import { diagnosticsTool } from '@cycgraph/tools/workspace';
import { checksEnv } from '../../shared/repo.js';
import type { IssueFixContext } from '../context.js';

/** The gate's `repo_checks` and the fixer's `workspace_check`, bound to the clone. */
export function checkTools(c: IssueFixContext) {
  const { workspaceAt, params: p, maintenance } = c;
  const runChecks = maintenance.runLocalChecks && p.checks.length > 0;

  const checks = diagnosticsTool({
    name: 'repo_checks',
    cwd: workspaceAt,
    command: runChecks ? 'sh' : 'true',
    ...(runChecks ? { args: ['-c', p.checks.join(' && ')] } : { args: [] }),
    // Sized for the full test suite, not just lint.
    timeoutMs: 1_800_000,
    maxLines: 120,
    env: checksEnv(),
  });

  const probe = diagnosticsTool({
    name: 'workspace_check',
    cwd: workspaceAt,
    command: runChecks ? 'sh' : 'true',
    ...(runChecks ? { args: ['-c', p.checks[0]!] } : { args: [] }),
    timeoutMs: 600_000,
    env: checksEnv(),
  });

  return { checks, probe };
}
