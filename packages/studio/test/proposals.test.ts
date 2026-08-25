/**
 * Tests for the proposals ledger (src/run/proposals.ts): saving winners,
 * status transitions, and what the run path is handed to apply.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  listProposals,
  readEpoch,
  saveProposals,
  setProposalStatus,
  trialChangesFor,
  writeEpoch,
} from '../src/improve/proposals.js';
import type { TuneOutcome } from '../src/improve/tune.js';
import type { SweepProposal, SweepVerdict } from '@cycgraph/evals';

let root: string;

const ITERATIONS = { kind: 'config' as const, node_id: 'boss', patch: { supervisor_config: { max_iterations: 3 } } };
const TEMPERATURE = { kind: 'temperature' as const, target: 'boss', temperature: 0.35 };

function proposal(partial: Partial<SweepProposal> = {}): SweepVerdict {
  return {
    kind: 'proposal',
    proposal: {
      sweepId: 'sweep:wf:boss:supervisor_config.max_iterations',
      workflow: 'wf',
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
      ...partial,
    },
  };
}

function outcomeWith(...verdicts: SweepVerdict[]): TuneOutcome {
  return {
    workflow: 'wf',
    baseRunIds: ['base-a'],
    sweeps: [],
    verdicts,
    estimates: [],
    forks: 0,
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cycgraph-proposals-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('saveProposals', () => {
  it('stores the per-variant outcomes the verdict was decided on', async () => {
    const measured = [
      { name: 'max_iterations=6', assertionsHeld: true, failed: [], computeMs: 20000, tokens: 2000 },
      { name: 'max_iterations=3', assertionsHeld: true, failed: [], computeMs: 9000, tokens: 900 },
    ];
    await saveProposals(root, outcomeWith(proposal({ outcomes: measured })));

    const [record] = await listProposals(root);
    expect(record?.evidence).toEqual(measured);
  });

  it('saves a winner with its evidence chain', async () => {
    const saved = await saveProposals(root, outcomeWith(proposal()));

    expect(saved).toEqual(['sweep:wf:boss:supervisor_config.max_iterations']);
    const [record] = await listProposals(root);
    expect(record).toMatchObject({
      status: 'proposed',
      from: 6,
      to: 3,
      computeDelta: 0.19,
      model: 'qwen2.5:7b',
      change: [ITERATIONS],
    });
  });

  it('saves nothing from rejections', async () => {
    const rejected: SweepVerdict = {
      kind: 'rejected',
      rejection: { sweepId: 's', workflow: 'wf', nodeId: 'boss', knob: 'k', reason: 'r', outcomes: [] },
    };

    expect(await saveProposals(root, outcomeWith(rejected))).toEqual([]);
  });

  it('attaches the held-out confirmation verdict', async () => {
    const outcome = outcomeWith(proposal());
    outcome.validations = {
      'sweep:wf:boss:supervisor_config.max_iterations': {
        kind: 'rejected',
        rejection: { sweepId: 's', workflow: 'wf', nodeId: 'boss', knob: 'k', reason: 'did not hold', outcomes: [] },
      },
    };

    await saveProposals(root, outcome);

    const [record] = await listProposals(root);
    expect(record!.validation).toEqual({ confirmed: false, detail: 'did not hold' });
  });

  it('updates the same entry when the knob is re-tuned', async () => {
    await saveProposals(root, outcomeWith(proposal({ to: 3 })));
    await saveProposals(root, outcomeWith(proposal({
      to: 2,
      change: [{ ...ITERATIONS, patch: { supervisor_config: { max_iterations: 2 } } }],
    })));

    const records = await listProposals(root);
    expect(records).toHaveLength(1);
    expect(records[0]!.to).toBe(2);
  });

  it('keeps acceptance across a resave of the identical change', async () => {
    await saveProposals(root, outcomeWith(proposal()));
    await setProposalStatus(root, 'max_iterations', 'trial');

    await saveProposals(root, outcomeWith(proposal({ computeDelta: 0.22 })));

    const [record] = await listProposals(root);
    expect(record).toMatchObject({ status: 'trial', computeDelta: 0.22 });
  });

  it('withdraws acceptance when the winning value changed', async () => {
    await saveProposals(root, outcomeWith(proposal()));
    await setProposalStatus(root, 'max_iterations', 'trial');

    await saveProposals(root, outcomeWith(proposal({
      to: 2,
      change: [{ ...ITERATIONS, patch: { supervisor_config: { max_iterations: 2 } } }],
    })));

    const [record] = await listProposals(root);
    expect(record!.status).toBe('proposed');
  });
});

describe('setProposalStatus', () => {
  it('moves a proposal by unambiguous prefix', async () => {
    await saveProposals(root, outcomeWith(proposal()));

    const result = await setProposalStatus(root, 'max_iterations', 'trial');

    expect('record' in result && result.record.status).toBe('trial');
  });

  it('records the inverse alongside an apply', async () => {
    await saveProposals(root, outcomeWith(proposal()));

    await setProposalStatus(root, 'max_iterations', 'applied', {
      inverse: [{ ...ITERATIONS, patch: { supervisor_config: { max_iterations: 6 } } }],
    });

    const [record] = await listProposals(root);
    expect(record!.inverse).toEqual([{ ...ITERATIONS, patch: { supervisor_config: { max_iterations: 6 } } }]);
  });

  it('reports an unknown target', async () => {
    const result = await setProposalStatus(root, 'ghost', 'applied');

    expect(result).toEqual({ error: "no proposal matching 'ghost'" });
  });

  it('refuses a trial that conflicts with what is already in effect', async () => {
    await saveProposals(root, outcomeWith(
      proposal(),
      proposal({
        sweepId: 'sweep:wf:boss:other', knob: 'other',
        change: [{ ...ITERATIONS, patch: { supervisor_config: { max_iterations: 2 } } }],
      }),
    ));
    await setProposalStatus(root, 'max_iterations', 'applied');

    const result = await setProposalStatus(root, 'other', 'trial');

    expect('error' in result && result.error).toContain('would conflict');
  });

  it('reverts a proposal', async () => {
    await saveProposals(root, outcomeWith(proposal()));
    await setProposalStatus(root, 'max_iterations', 'trial');

    await setProposalStatus(root, 'max_iterations', 'reverted');

    const [record] = await listProposals(root);
    expect(record!.status).toBe('reverted');
  });
});

describe('trialChangesFor', () => {
  it('hands the run path only what is on trial', async () => {
    await saveProposals(root, outcomeWith(
      proposal(),
      proposal({ sweepId: 'sweep:wf:boss:temperature', knob: 'temperature', change: [TEMPERATURE] }),
    ));
    await setProposalStatus(root, 'temperature', 'trial');

    const accepted = await trialChangesFor(root, 'wf');

    expect(accepted).toEqual({ ids: ['sweep:wf:boss:temperature'], changes: [TEMPERATURE] });
  });

  it('never overlays an applied proposal, which lives in the source now', async () => {
    await saveProposals(root, outcomeWith(proposal()));
    await setProposalStatus(root, 'max_iterations', 'applied');

    expect(await trialChangesFor(root, 'wf')).toEqual({ ids: [], changes: [] });
  });

  it('scopes to the workflow asked about', async () => {
    await saveProposals(root, outcomeWith(proposal()));
    await setProposalStatus(root, 'max_iterations', 'trial');

    expect(await trialChangesFor(root, 'other-wf')).toEqual({ ids: [], changes: [] });
  });

  it('hands back nothing when nothing is on trial', async () => {
    await saveProposals(root, outcomeWith(proposal()));

    expect(await trialChangesFor(root, 'wf')).toEqual({ ids: [], changes: [] });
  });
});

describe('the corpus epoch', () => {
  it('is absent until a source write records one', async () => {
    expect(await readEpoch(root)).toBeUndefined();
  });

  it('reads back what a source write recorded', async () => {
    await writeEpoch(root);

    const epoch = await readEpoch(root);
    expect(typeof epoch).toBe('string');
    expect(new Date(epoch!).getTime()).not.toBeNaN();
  });
});
