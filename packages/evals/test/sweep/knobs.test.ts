/**
 * Tests for the knob enumerator (src/sweep/knobs.ts).
 */

import { describe, it, expect } from 'vitest';
import {
  enumerateFromFinding,
  enumerateFromProfile,
  enumerateSweeps,
} from '../../src/sweep/knobs.js';
import { annealingGraph, finding, nodeProfile, supervisorGraph, workflowProfile } from './helpers.js';

const CAP_REACHED = 'signal:wf:max_iterations_reached:boss';
const NON_RETRYABLE = 'signal:wf:node_error_non_retryable:worker';

describe('enumerateFromFinding', () => {
  it('sweeps a supervisor upward when it exhausts its iteration cap', () => {
    const sweep = enumerateFromFinding(
      finding({ id: CAP_REACHED, nodeId: 'boss' }),
      supervisorGraph(6),
    );

    expect(Object.keys(sweep!.variants)).toEqual([
      'max_iterations=6', 'max_iterations=12', 'max_iterations=24', 'max_iterations=48',
    ]);
  });

  it('names the unchanged value as the control of an upward sweep', () => {
    const sweep = enumerateFromFinding(finding({ id: CAP_REACHED, nodeId: 'boss' }), supervisorGraph(6));

    expect(sweep!.control).toBe('max_iterations=6');
  });

  it('treats an exhausted cap as a correctness question', () => {
    const sweep = enumerateFromFinding(finding({ id: CAP_REACHED, nodeId: 'boss' }), supervisorGraph(6));

    expect(sweep!.objective).toBe('correctness');
  });

  it('reads the current value from the graph', () => {
    const sweep = enumerateFromFinding(finding({ id: CAP_REACHED, nodeId: 'boss' }), supervisorGraph(3));

    expect(sweep!.current).toBe(3);
  });

  it('produces a change that patches only the swept field', () => {
    const sweep = enumerateFromFinding(finding({ id: CAP_REACHED, nodeId: 'boss' }), supervisorGraph(6));

    expect(sweep!.variants['max_iterations=12']).toEqual([{
      kind: 'config',
      node_id: 'boss',
      patch: { supervisor_config: { managed_nodes: ['worker'], max_iterations: 12 } },
    }]);
  });

  it('stops at the schema bound', () => {
    const sweep = enumerateFromFinding(finding({ id: CAP_REACHED, nodeId: 'boss' }), supervisorGraph(600));

    expect(Object.keys(sweep!.variants)).toEqual(['max_iterations=600', 'max_iterations=1000']);
  });

  it('ignores a non-retryable failure, which no budget can fix', () => {
    const sweep = enumerateFromFinding(
      finding({ id: NON_RETRYABLE, nodeId: 'worker', workflow: 'wf' }),
      supervisorGraph(),
    );

    expect(sweep).toBeUndefined();
  });

  it('ignores a finding that names no node', () => {
    expect(enumerateFromFinding(finding({ id: CAP_REACHED }), supervisorGraph())).toBeUndefined();
  });

  it('ignores a finding naming a node the graph does not hold', () => {
    const sweep = enumerateFromFinding(
      finding({ id: 'signal:wf:max_iterations_reached:ghost', nodeId: 'ghost' }),
      supervisorGraph(),
    );

    expect(sweep).toBeUndefined();
  });

  it('ignores a signal whose remedy is not a knob', () => {
    const sweep = enumerateFromFinding(
      finding({ id: 'signal:wf:no_matching_edge:boss', nodeId: 'boss' }),
      supervisorGraph(),
    );

    expect(sweep).toBeUndefined();
  });

  it('ignores an assertion finding, which names no signal', () => {
    const sweep = enumerateFromFinding(
      finding({ id: 'assertion:wf:status_equals', nodeId: 'boss' }),
      supervisorGraph(),
    );

    expect(sweep).toBeUndefined();
  });

  it('does not apply an iteration knob to a node that has none', () => {
    const sweep = enumerateFromFinding(
      finding({ id: 'signal:wf:max_iterations_reached:worker', nodeId: 'worker' }),
      supervisorGraph(),
    );

    expect(sweep).toBeUndefined();
  });

  it('derives an id from the node and knob rather than the finding', () => {
    const sweep = enumerateFromFinding(finding({ id: CAP_REACHED, nodeId: 'boss' }), supervisorGraph(6));

    expect(sweep!.id).toBe('sweep:wf:boss:supervisor_config.max_iterations');
  });
});

describe('enumerateFromProfile', () => {
  const profile = workflowProfile([nodeProfile({})]);

  it('sweeps a repeatedly visited node downward', () => {
    const sweep = enumerateFromProfile(profile, nodeProfile({}), supervisorGraph(6));

    expect(Object.keys(sweep!.variants)).toEqual(['max_iterations=3', 'max_iterations=1']);
  });

  it('treats a dominant node as a cost question', () => {
    const sweep = enumerateFromProfile(profile, nodeProfile({}), supervisorGraph(6));

    expect(sweep!.objective).toBe('cost');
  });

  it('says what share and visit count motivated it', () => {
    const sweep = enumerateFromProfile(profile, nodeProfile({}), supervisorGraph(6));

    expect(sweep!.reason).toContain('66% of execution time across 4.2 visits');
  });

  it('ignores a node visited about once a run', () => {
    const sweep = enumerateFromProfile(profile, nodeProfile({ visitsPerRun: 1 }), supervisorGraph(6));

    expect(sweep).toBeUndefined();
  });

  it('ignores a node too small to be worth optimising', () => {
    const sweep = enumerateFromProfile(profile, nodeProfile({ timeShare: 0.05 }), supervisorGraph(6));

    expect(sweep).toBeUndefined();
  });

  it('ignores a node the graph does not hold', () => {
    const sweep = enumerateFromProfile(profile, nodeProfile({ nodeId: 'ghost' }), supervisorGraph(6));

    expect(sweep).toBeUndefined();
  });

  it('stops at the schema bound rather than proposing zero', () => {
    const sweep = enumerateFromProfile(profile, nodeProfile({}), supervisorGraph(2));

    expect(Object.keys(sweep!.variants)).toEqual(['max_iterations=1']);
  });

  it('proposes nothing when the knob is already at its floor', () => {
    const sweep = enumerateFromProfile(profile, nodeProfile({}), supervisorGraph(1));

    expect(sweep).toBeUndefined();
  });
});

describe('enumerateSweeps', () => {
  it('takes a sweep from the profile when no finding motivates one', () => {
    const sweeps = enumerateSweeps(
      [finding({ id: NON_RETRYABLE, nodeId: 'worker' })],
      workflowProfile([nodeProfile({})]),
      supervisorGraph(6),
    );

    expect(sweeps.map(s => s.knob)).toEqual(['supervisor_config.max_iterations']);
  });

  it('measures one knob once, letting the finding win over the profile', () => {
    const sweeps = enumerateSweeps(
      [finding({ id: CAP_REACHED, nodeId: 'boss' })],
      workflowProfile([nodeProfile({})]),
      supervisorGraph(6),
    );

    expect(sweeps).toHaveLength(1);
    expect(sweeps[0]!.objective).toBe('correctness');
  });

  it('lets the cost question claim an exhausted cap when every run passes', () => {
    const sweeps = enumerateSweeps(
      [finding({ id: CAP_REACHED, nodeId: 'boss' })],
      workflowProfile([nodeProfile({})]),
      supervisorGraph(6),
      { cleanRunRate: 1 },
    );

    expect(sweeps).toHaveLength(1);
    expect(sweeps[0]!.objective).toBe('cost');
  });

  it('keeps the correctness question when any run fails', () => {
    const sweeps = enumerateSweeps(
      [finding({ id: CAP_REACHED, nodeId: 'boss' })],
      workflowProfile([nodeProfile({})]),
      supervisorGraph(6),
      { cleanRunRate: 0.8 },
    );

    expect(sweeps[0]!.objective).toBe('correctness');
  });

  it('works with no profile at all', () => {
    const sweeps = enumerateSweeps(
      [finding({ id: CAP_REACHED, nodeId: 'boss' })],
      undefined,
      supervisorGraph(6),
    );

    expect(sweeps).toHaveLength(1);
  });

  it('returns nothing when nothing is sweepable', () => {
    expect(enumerateSweeps([], undefined, supervisorGraph())).toEqual([]);
  });
});

describe('enumerateFromProfile — annealing', () => {
  const profile = workflowProfile([nodeProfile({ nodeId: 'refine', type: 'agent' })]);

  it('sweeps an annealing loop downward like any other budget', () => {
    const sweep = enumerateFromProfile(
      profile,
      nodeProfile({ nodeId: 'refine', type: 'agent' }),
      annealingGraph(8),
    );

    expect(sweep!.knob).toBe('annealing_config.max_iterations');
    expect(Object.keys(sweep!.variants)).toEqual(['max_iterations=4', 'max_iterations=2', 'max_iterations=1']);
  });
});

describe('enumerateSweeps — models', () => {
  const profile = workflowProfile([nodeProfile({})]);

  it('sweeps a model over a node worth optimising', () => {
    const sweeps = enumerateSweeps([], profile, supervisorGraph(6), {
      models: ['a', 'b'],
      currentModel: 'a',
    });

    const models = sweeps.find(s => s.knob === 'model');
    expect(Object.keys(models!.variants)).toEqual(['model=b']);
  });

  it('records the model in force as the value it is replacing', () => {
    const sweeps = enumerateSweeps([], profile, supervisorGraph(6), {
      models: ['b'],
      currentModel: 'a',
    });

    expect(sweeps.find(s => s.knob === 'model')!.current).toBe('a');
  });

  it('produces a model change per candidate', () => {
    const sweeps = enumerateSweeps([], profile, supervisorGraph(6), { models: ['b'] });

    expect(sweeps.find(s => s.knob === 'model')!.variants['model=b'])
      .toEqual([{ kind: 'model', target: 'boss', model: 'b' }]);
  });

  it('sweeps nothing when no models were supplied', () => {
    const sweeps = enumerateSweeps([], profile, supervisorGraph(6), {});

    expect(sweeps.some(s => s.knob === 'model')).toBe(false);
  });

  it('never proposes the model already in force', () => {
    const sweeps = enumerateSweeps([], profile, supervisorGraph(6), {
      models: ['a'],
      currentModel: 'a',
    });

    expect(sweeps.some(s => s.knob === 'model')).toBe(false);
  });

  it('ignores a node too small to be worth optimising', () => {
    const small = workflowProfile([nodeProfile({ timeShare: 0.05 })]);

    const sweeps = enumerateSweeps([], small, supervisorGraph(6), { models: ['b'] });

    expect(sweeps.some(s => s.knob === 'model')).toBe(false);
  });

  it('sweeps a model on a node visited once, which no budget reaches', () => {
    const once = workflowProfile([
      nodeProfile({ nodeId: 'worker', type: 'agent', visitsPerRun: 1, timeShare: 0.6 }),
    ]);

    const sweeps = enumerateSweeps([], once, supervisorGraph(6), { models: ['b'] });

    expect(sweeps.map(s => `${s.nodeId}.${s.knob}`)).toEqual(['worker.model']);
  });

  it('asks the budget question and the model question separately', () => {
    const sweeps = enumerateSweeps([], profile, supervisorGraph(6), { models: ['b'] });

    expect(sweeps.map(s => s.knob).sort()).toEqual(['model', 'supervisor_config.max_iterations']);
  });

  it('derives an id that names the node and the knob', () => {
    const sweeps = enumerateSweeps([], profile, supervisorGraph(6), { models: ['b'] });

    expect(sweeps.find(s => s.knob === 'model')!.id).toBe('sweep:wf:boss:model');
  });
});
