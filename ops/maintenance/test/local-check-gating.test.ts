/**
 * Local-check gating: with `runLocalChecks` off (the product), the run
 * executes no tree code and treats the repository's CI as the gate. The
 * clearest observable is the reviser's tool set — run_check is wired only
 * when local checks are on. Builds the real agent from a context, so the
 * wiring under test is the wiring the workflow uses.
 */

import { describe, it, expect } from 'vitest';
import { createWorkspaceSession } from '@cycgraph/tools/workspace';
import { defaultMaintenanceContext } from '../src/shared/context.js';
import { maintenanceEnvFromProcess } from '../src/shared/env.js';
import { prRevise } from '../src/pr-revise/index.js';
import { reviseTools } from '../src/pr-revise/tools/index.js';
import { reviserAgent } from '../src/pr-revise/agents/reviser.js';
import type { ReviseContext } from '../src/pr-revise/context.js';

function contextWith(runLocalChecks: boolean): ReviseContext {
  return {
    params: prRevise().params.parse({ pr: 1 }),
    env: maintenanceEnvFromProcess({}),
    repoRoot: process.cwd(),
    maintenance: { ...defaultMaintenanceContext(), runLocalChecks },
    standardsBrief: 'brief',
    workspaceAt: '/tmp/cycgraph-pr-revise-test',
    session: createWorkspaceSession(),
    token: undefined,
  };
}

function reviserToolNames(context: ReviseContext): string[] {
  const reviser = reviserAgent(context, reviseTools(context));
  return (reviser.spec.tools ?? []).map((tool) => (tool as { name?: string }).name ?? '');
}

describe('pr-revise local-check gating', () => {
  it('wires run_check for the reviser when local checks are on', () => {
    expect(reviserToolNames(contextWith(true))).toContain('run_check');
  });

  it('drops run_check when local checks are off, leaving only the editing hands', () => {
    const names = reviserToolNames(contextWith(false));

    expect(names).not.toContain('run_check');
    expect(names).toContain('read_file');
    expect(names).toContain('edit_file');
  });
});
