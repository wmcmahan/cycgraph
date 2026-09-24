/**
 * Agent tier wiring: a real agent built from a tiered env carries the
 * tier's model, its preference, and an explicit effort level.
 */

import { describe, it, expect } from 'vitest';
import { createWorkspaceSession } from '@cycgraph/tools/workspace';
import { defaultMaintenanceContext } from '../src/shared/context.js';
import { maintenanceEnvFromProcess } from '../src/shared/env.js';
import { prRevise } from '../src/pr-revise/index.js';
import { reviseTools } from '../src/pr-revise/tools/index.js';
import { reviserAgent } from '../src/pr-revise/agents/reviser.js';
import type { ReviseContext } from '../src/pr-revise/context.js';

const TIERED_ENV = {
  CYCGRAPH_MODEL: 'claude-opus-5',
  CYCGRAPH_MODEL_MEDIUM: 'claude-sonnet-5',
  CYCGRAPH_MODEL_LOW: 'claude-sonnet-5',
};

function tieredContext(): ReviseContext {
  return {
    params: prRevise().params.parse({ pr: 1 }),
    env: maintenanceEnvFromProcess(TIERED_ENV),
    repoRoot: process.cwd(),
    maintenance: defaultMaintenanceContext(),
    standardsBrief: 'brief',
    workspaceAt: '/tmp/cycgraph-agent-tiers-test',
    session: createWorkspaceSession(),
    token: undefined,
  };
}

describe('reviserAgent', () => {
  it('runs on the high tier at explicit high effort', () => {
    const context = tieredContext();

    const reviser = reviserAgent(context, reviseTools(context));

    expect(reviser.spec.model).toBe('claude-opus-5');
    expect(reviser.spec.modelPreference).toBe('high');
    expect(reviser.spec.effort).toBe('high');
  });
});
