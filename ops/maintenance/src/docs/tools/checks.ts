/**
 * repo_checks — the gate's check run over the fix.
 *
 * A docs fix should not break the build; when a project declares no checks,
 * or local checks are off in the product, this is a no-op that always
 * passes and CI is the gate.
 *
 * @module maintenance/docs/tools/checks
 */

import { diagnosticsTool } from '@cycgraph/tools/workspace';
import { checksEnv } from '../../shared/repo.js';
import type { DocsContext } from '../context.js';

/** The repo_checks tool, bound to the clone. */
export function checksTool(c: DocsContext) {
  const { workspaceAt, params: p, maintenance } = c;
  const runChecks = maintenance.runLocalChecks && p.checks.length > 0;
  return diagnosticsTool({
    name: 'repo_checks',
    cwd: workspaceAt,
    command: runChecks ? 'sh' : 'true',
    ...(runChecks ? { args: ['-c', p.checks.join(' && ')] } : { args: [] }),
    timeoutMs: 600_000,
    env: checksEnv(),
  });
}
