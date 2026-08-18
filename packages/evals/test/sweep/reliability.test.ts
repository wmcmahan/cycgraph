/**
 * Tests for the reliability sweep: temperature enumeration (src/sweep/knobs.ts)
 * and the rate-based decision branch (src/sweep/decide.ts).
 */

import { describe, it, expect } from 'vitest';
import { enumerateSweeps } from '../../src/sweep/knobs.js';
import { decideSweep } from '../../src/sweep/decide.js';
import type { KnobSweep, SweepVerdict } from '../../src/sweep/types.js';
import { baseline, finding, nodeProfile, outcome, supervisorGraph, workflowProfile } from './helpers.js';

const FLAKY = finding({
  id: 'assertion:wf:status_equals',
  detector: 'assertions',
  severity: 'medium',
  detail: '2 of 36 runs (6%) — Expected status "completed", got "failed"',
});

const FIXED_TEMP = nodeProfile({
  nodeId: 'boss',
  type: 'supervisor',
  temperature: { min: 0.7, max: 0.7 },
});

function temperatureSweepOf(sweeps: KnobSweep[]): KnobSweep {
  const sweep = sweeps.find(s => s.knob === 'temperature');
  if (!sweep) throw new Error('no temperature sweep enumerated');
  return sweep;
}

describe('enumerateSweeps — temperature', () => {
  it('sweeps temperature on an intermittently failing workflow', () => {
    const sweeps = enumerateSweeps([FLAKY], workflowProfile([FIXED_TEMP]), supervisorGraph(6));

    const sweep = temperatureSweepOf(sweeps);
    expect(Object.keys(sweep.variants)).toEqual([
      'temperature=0.7', 'temperature=0.35', 'temperature=0',
    ]);
  });

  it('names the unchanged arm as the control', () => {
    const sweeps = enumerateSweeps([FLAKY], workflowProfile([FIXED_TEMP]), supervisorGraph(6));

    expect(temperatureSweepOf(sweeps).control).toBe('temperature=0.7');
  });

  it('asks for several samples per arm', () => {
    const sweeps = enumerateSweeps([FLAKY], workflowProfile([FIXED_TEMP]), supervisorGraph(6));

    expect(temperatureSweepOf(sweeps).samples).toBe(5);
  });

  it('reads the current value from what recorded calls sampled at', () => {
    const sweeps = enumerateSweeps([FLAKY], workflowProfile([FIXED_TEMP]), supervisorGraph(6));

    expect(temperatureSweepOf(sweeps).current).toBe(0.7);
  });

  it('produces a temperature change per arm', () => {
    const sweeps = enumerateSweeps([FLAKY], workflowProfile([FIXED_TEMP]), supervisorGraph(6));

    expect(temperatureSweepOf(sweeps).variants['temperature=0']).toEqual([
      { kind: 'temperature', target: 'boss', temperature: 0 },
    ]);
  });

  it('says what motivated it', () => {
    const sweeps = enumerateSweeps([FLAKY], workflowProfile([FIXED_TEMP]), supervisorGraph(6));

    expect(temperatureSweepOf(sweeps).reason).toContain('2 of 36 runs (6%)');
  });

  it('stays silent when the workflow is not flaky', () => {
    const sweeps = enumerateSweeps([], workflowProfile([FIXED_TEMP]), supervisorGraph(6));

    expect(sweeps.some(s => s.knob === 'temperature')).toBe(false);
  });

  it('stays silent when the workflow fails outright rather than sometimes', () => {
    const broken = finding({ id: 'assertion:wf:status_equals', detector: 'assertions', severity: 'high' });

    const sweeps = enumerateSweeps([broken], workflowProfile([FIXED_TEMP]), supervisorGraph(6));

    expect(sweeps.some(s => s.knob === 'temperature')).toBe(false);
  });

  it('skips a node whose observed temperature is a schedule', () => {
    const scheduled = nodeProfile({ nodeId: 'boss', temperature: { min: 0.3, max: 1.0 } });

    const sweeps = enumerateSweeps([FLAKY], workflowProfile([scheduled]), supervisorGraph(6));

    expect(sweeps.some(s => s.knob === 'temperature')).toBe(false);
  });

  it('skips a node with no observed temperature', () => {
    const untempered = nodeProfile({ nodeId: 'boss' });

    const sweeps = enumerateSweeps([FLAKY], workflowProfile([untempered]), supervisorGraph(6));

    expect(sweeps.some(s => s.knob === 'temperature')).toBe(false);
  });

  it('has nothing to try below a node already sampling greedily', () => {
    const greedy = nodeProfile({ nodeId: 'boss', temperature: { min: 0, max: 0 } });

    const sweeps = enumerateSweeps([FLAKY], workflowProfile([greedy]), supervisorGraph(6));

    expect(sweeps.some(s => s.knob === 'temperature')).toBe(false);
  });

  it('derives an id that names the node and the knob', () => {
    const sweeps = enumerateSweeps([FLAKY], workflowProfile([FIXED_TEMP]), supervisorGraph(6));

    expect(temperatureSweepOf(sweeps).id).toBe('sweep:wf:boss:temperature');
  });
});

describe('decideSweep — reliability', () => {
  function sweep(): KnobSweep {
    return {
      id: 'sweep:wf:boss:temperature',
      workflow: 'wf',
      nodeId: 'boss',
      knob: 'temperature',
      current: 0.7,
      objective: 'reliability',
      reason: 'r',
      variants: { 'temperature=0.7': [], 'temperature=0': [] },
      control: 'temperature=0.7',
      samples: 5,
    };
  }

  function arm(name: string, results: readonly boolean[], ms = 1000): ReturnType<typeof outcome>[] {
    return results.map((passed, index) => outcome({
      name,
      runId: `${name}-${index}`,
      assertionsHeld: passed,
      failed: passed ? [] : ['status_equals'],
      computeMs: ms,
    }));
  }

  function proposal(verdict: SweepVerdict) {
    if (verdict.kind !== 'proposal') throw new Error(`expected a proposal, got: ${verdict.rejection.reason}`);
    return verdict.proposal;
  }

  function rejection(verdict: SweepVerdict) {
    if (verdict.kind !== 'rejected') throw new Error('expected a rejection');
    return verdict.rejection;
  }

  it('proposes an arm that passes distinguishably more often than the control', () => {
    const verdict = decideSweep(sweep(), [baseline()], [
      ...arm('temperature=0.7', [true, false, false, false, false]),
      ...arm('temperature=0', [true, true, true, true, true]),
    ]);

    expect(proposal(verdict).to).toBe(0);
  });

  it('carries the rate comparison on the proposal', () => {
    const verdict = decideSweep(sweep(), [baseline()], [
      ...arm('temperature=0.7', [true, false, false, false, false]),
      ...arm('temperature=0', [true, true, true, true, true]),
    ]);

    expect(proposal(verdict).reliability).toEqual({
      winnerPassed: 5,
      winnerOf: 5,
      controlPassed: 1,
      controlOf: 5,
      pValue: expect.closeTo(5 / 210, 10),
    });
  });

  it('rejects a perfect arm the exact test cannot distinguish at five samples', () => {
    const verdict = decideSweep(sweep(), [baseline()], [
      ...arm('temperature=0.7', [true, true, false, false, false]),
      ...arm('temperature=0', [true, true, true, true, true]),
    ]);

    expect(rejection(verdict).reason).toContain('5/5 against the control\'s 2/5');
    expect(rejection(verdict).reason).toContain('more samples would be needed');
  });

  it('rejects when the unreliability does not reproduce in the control', () => {
    const verdict = decideSweep(sweep(), [baseline()], [
      ...arm('temperature=0.7', [true, true, true, true, true]),
      ...arm('temperature=0', [true, true, true, true, true]),
    ]);

    expect(rejection(verdict).reason).toBe('the unreliability did not reproduce: the control held in all 5 sample(s)');
  });

  it('rejects when the control arm did not complete everywhere', () => {
    const verdict = decideSweep(sweep(), [baseline()], [
      ...arm('temperature=0.7', [true, false]),
      ...arm('temperature=0', [true, true, true, true, true]),
    ]);

    expect(rejection(verdict).reason).toBe('the control arm did not complete everywhere, so there is no rate to compare against');
  });

  it('counts an errored sample as a failure to pass', () => {
    const errored = [
      ...arm('temperature=0.7', [false, false, false, false]),
      outcome({ name: 'temperature=0.7', computeMs: 0, error: 'tail crashed', assertionsHeld: false, failed: [] }),
      ...arm('temperature=0', [true, true, true, true, true]),
    ];

    const verdict = decideSweep(sweep(), [baseline()], errored);

    expect(proposal(verdict).reliability!.controlPassed).toBe(0);
  });

  it('measures the cost delta against the control arm rather than history', () => {
    const verdict = decideSweep(sweep(), [baseline({ computeMs: 99_999 })], [
      ...arm('temperature=0.7', [true, false, false, false, false], 2000),
      ...arm('temperature=0', [true, true, true, true, true], 1000),
    ]);

    expect(proposal(verdict).computeDelta).toBeCloseTo(0.5);
  });

  it('prefers the higher pass rate between two significant arms', () => {
    const wide = sweep();
    wide.variants['temperature=0.35'] = [];

    const verdict = decideSweep(wide, [baseline()], [
      ...arm('temperature=0.7', [false, false, false, false, false]),
      ...arm('temperature=0.35', [true, true, true, true, false]),
      ...arm('temperature=0', [true, true, true, true, true]),
    ]);

    expect(proposal(verdict).to).toBe(0);
  });
});
