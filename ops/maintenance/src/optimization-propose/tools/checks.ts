/**
 * repo_checks — the gate's check run over the proposal.
 *
 * Off in the product (`runLocalChecks` false) and when no checks are
 * configured: it runs `true`, a no-op that always passes, and CI is the
 * gate.
 *
 * @module maintenance/optimization-propose/tools/checks
 */

import { diagnosticsTool } from '@cycgraph/tools/workspace';
import { checksEnv } from '../../shared/repo.js';
import type { OptProposeContext } from '../context.js';

/** The repo_checks tool, bound to the clone. */
export function checksTool(c: OptProposeContext) {
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
