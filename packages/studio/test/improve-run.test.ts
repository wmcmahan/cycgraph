/**
 * Run-path tests for the improve ladder (src/run/improve.ts): the real
 * engine walks the gates while the tune and apply stages are stubbed
 * through the driver seam.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import {
  InMemoryEventLogWriter,
  InMemoryPersistenceProvider,
  type HumanResponse,
} from '@cycgraph/orchestrator';
import { improveWorkflow } from '../src/improve/improve.js';
import type { ImproveDrivers } from '../src/improve/improve.js';
import { listProposals, readEpoch } from '../src/improve/proposals.js';
import type { TuneOutcome } from '../src/improve/tune.js';
import { scenario } from '../src/scenarios/types.js';
import { defaultStackConfig, type Stack } from '../src/stack/index.js';
import type { SweepVerdict } from '@cycgraph/evals';

let root: string;

const target = scenario({
  id: 'target',
  title: 'Target under improvement',
  covers: [],
  requires: [],
  params: z.object({}),
  build: async () => {
    throw new Error('build is only reached by the real tune driver');
  },
});

const ITERATIONS = { kind: 'config' as const, node_id: 'boss', patch: { supervisor_config: { max_iterations: 3 } } };

const PROPOSAL: SweepVerdict = {
  kind: 'proposal',
  proposal: {
    sweepId: 'sweep:target:boss:supervisor_config.max_iterations',
    workflow: 'target',
    nodeId: 'boss',
    knob: 'supervisor_config.max_iterations',
    from: 6,
    to: 3,
    objective: 'cost',
    model: 'qwen2.5:7b',
    change: [ITERATIONS],
    computeDelta: 0.19,
    tokenDelta: 0.24,
    measuredOn: ['base-a'],
    outcomes: [],
  },
};

const KEEP: SweepVerdict = {
  kind: 'rejected',
  rejection: {
    sweepId: 'sweep:target:boss:supervisor_config.max_iterations',
    workflow: 'target',
    nodeId: 'boss',
    knob: 'supervisor_config.max_iterations',
    reason: 'no candidate cleared the bar',
    outcomes: [],
  },
};

function tuneOutcome(...verdicts: SweepVerdict[]): TuneOutcome {
  return {
    workflow: 'target',
    baseRunIds: ['base-a'],
    sweeps: [],
    verdicts,
    estimates: [],
    forks: 0,
  };
}

function fakeStack(): Stack {
  return {
    config: { ...defaultStackConfig(), artifactRoot: root },
    available: new Set(),
    gaps: [],
    persistence: new InMemoryPersistenceProvider(),
    eventLog: new InMemoryEventLogWriter(),
    close: async () => {},
  };
}

function drivers(verdicts: SweepVerdict[], applied: string[]): ImproveDrivers {
  return {
    tune: async () => tuneOutcome(...verdicts),
    apply: async (record) => {
      applied.push(record.id);
      return {
        branch: 'tune/test-branch',
        workspace: '/tmp/test-workspace',
        files: ['scenario.ts'],
        prCommand: 'git push …',
      };
    },
  };
}

function scriptedGates(answers: Array<'approved' | 'rejected'>) {
  const remaining = [...answers];
  return async (): Promise<HumanResponse> => {
    const decision = remaining.shift();
    if (!decision) throw new Error('a gate asked for more answers than the script holds');
    return { decision };
  };
}

async function runLadder(verdicts: SweepVerdict[], answers: Array<'approved' | 'rejected'>) {
  const applied: string[] = [];
  const outcome = await improveWorkflow(target, {}, fakeStack(), {
    repoRoot: '/tmp/unused',
    hitl: scriptedGates(answers),
    drivers: drivers(verdicts, applied),
  });
  return { outcome, applied };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cycgraph-improve-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('improveWorkflow', () => {
  it('walks an approved proposal to applied and records the epoch', async () => {
    const { outcome, applied } = await runLadder([PROPOSAL], ['approved', 'approved', 'approved']);

    expect(outcome.status).toBe('completed');
    expect(outcome.resumes).toBe(3);
    expect(outcome.finalState?.visited_nodes).toContain('merged');
    expect(applied).toEqual(['sweep:target:boss:supervisor_config.max_iterations']);

    const [record] = await listProposals(root);
    expect(record?.status).toBe('applied');
    expect(record?.branch).toBe('tune/test-branch');
    expect(await readEpoch(root)).toBeDefined();
  });

  it('leaves a proposal in trial when the apply gate is rejected', async () => {
    const { outcome, applied } = await runLadder([PROPOSAL], ['approved', 'rejected']);

    expect(outcome.status).toBe('completed');
    expect(outcome.finalState?.visited_nodes).toContain('leave');
    expect(outcome.finalState?.visited_nodes).not.toContain('apply');
    expect(applied).toEqual([]);

    const [record] = await listProposals(root);
    expect(record?.status).toBe('trial');
    expect(await readEpoch(root)).toBeUndefined();
  });

  it('leaves a proposal at proposed when the trial gate is rejected', async () => {
    const { outcome } = await runLadder([PROPOSAL], ['rejected']);

    expect(outcome.status).toBe('completed');
    expect(outcome.finalState?.visited_nodes).toContain('leave');

    const [record] = await listProposals(root);
    expect(record?.status).toBe('proposed');
  });

  it('carries the subgraph-shaped ladder to trial when apply is rejected', async () => {
    const outcome = await improveWorkflow(target, {}, fakeStack(), {
      repoRoot: '/tmp/unused',
      hitl: scriptedGates(['approved', 'rejected']),
      drivers: { tune: async () => tuneOutcome(PROPOSAL) },
    });

    expect(outcome.status).toBe('completed');
    expect(outcome.finalState?.visited_nodes).toContain('leave');
    expect(outcome.finalState?.visited_nodes).not.toContain('brief');

    const [record] = await listProposals(root);
    expect(record?.status).toBe('trial');
  });

  it('ends without pausing when every sweep said keep', async () => {
    const { outcome, applied } = await runLadder([KEEP], []);

    expect(outcome.status).toBe('completed');
    expect(outcome.resumes).toBe(0);
    expect(outcome.finalState?.visited_nodes).toContain('leave');
    expect(applied).toEqual([]);
    expect(await listProposals(root)).toEqual([]);
  });
});
