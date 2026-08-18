/**
 * Tests for decideSweep (src/sweep/decide.ts).
 */

import { describe, it, expect } from 'vitest';
import { decideSweep } from '../../src/sweep/decide.js';
import type { KnobSweep, SweepVerdict } from '../../src/sweep/types.js';
import { baseline, outcome } from './helpers.js';

function sweep(objective: KnobSweep['objective'], values = [3, 1]): KnobSweep {
  return {
    id: 'sweep:wf:boss:supervisor_config.max_iterations',
    workflow: 'wf',
    nodeId: 'boss',
    knob: 'supervisor_config.max_iterations',
    current: 6,
    objective,
    reason: 'r',
    variants: Object.fromEntries(values.map(v => [`max_iterations=${v}`, []])),
  };
}

function proposal(verdict: SweepVerdict) {
  if (verdict.kind !== 'proposal') throw new Error(`expected a proposal, got: ${verdict.rejection.reason}`);
  return verdict.proposal;
}

function rejection(verdict: SweepVerdict) {
  if (verdict.kind !== 'rejected') throw new Error('expected a rejection');
  return verdict.rejection;
}

describe('decideSweep — cost', () => {
  it('proposes the candidate that saved the most', () => {
    const verdict = decideSweep(sweep('cost'), [baseline()], [
      outcome({ name: 'max_iterations=3', computeMs: 6000 }),
      outcome({ name: 'max_iterations=1', computeMs: 3000 }),
    ]);

    expect(proposal(verdict).to).toBe(1);
  });

  it('reports what the winner saved', () => {
    const verdict = decideSweep(sweep('cost'), [baseline({ computeMs: 10_000, tokens: 1000 })], [
      outcome({ name: 'max_iterations=3', computeMs: 6000, tokens: 700 }),
      outcome({ name: 'max_iterations=1', computeMs: 3000, tokens: 400 }),
    ]);

    expect(proposal(verdict).computeDelta).toBeCloseTo(0.7);
    expect(proposal(verdict).tokenDelta).toBeCloseTo(0.6);
  });

  it('rejects a candidate that broke an assertion however much it saved', () => {
    const verdict = decideSweep(sweep('cost', [1]), [baseline({ computeMs: 10_000 })], [
      outcome({ name: 'max_iterations=1', computeMs: 100, assertionsHeld: false, failed: ['status_equals'] }),
    ]);

    expect(rejection(verdict).reason).toBe('every candidate broke an assertion the base run held');
  });

  it('proposes the best candidate that held when another did not', () => {
    const verdict = decideSweep(sweep('cost'), [baseline()], [
      outcome({ name: 'max_iterations=3', computeMs: 5000 }),
      outcome({ name: 'max_iterations=1', computeMs: 100, assertionsHeld: false, failed: ['status_equals'] }),
    ]);

    expect(proposal(verdict).to).toBe(3);
  });

  it('rejects a saving too small to be more than a redraw', () => {
    const verdict = decideSweep(sweep('cost'), [baseline({ computeMs: 10_000 })], [
      outcome({ name: 'max_iterations=3', computeMs: 9700 }),
      outcome({ name: 'max_iterations=1', computeMs: 9500 }),
    ]);

    expect(rejection(verdict).reason).toContain('at least 10%');
  });

  it('rejects when every candidate broke an assertion', () => {
    const verdict = decideSweep(sweep('cost'), [baseline()], [
      outcome({ name: 'max_iterations=3', computeMs: 100, assertionsHeld: false, failed: ['x'] }),
      outcome({ name: 'max_iterations=1', computeMs: 100, assertionsHeld: false, failed: ['x'] }),
    ]);

    expect(rejection(verdict).reason).toBe('every candidate broke an assertion the base run held');
  });

  it('refuses to optimise a base run that does not hold its own assertions', () => {
    const verdict = decideSweep(sweep('cost'), [baseline({ assertionsHeld: false })], [
      outcome({ name: 'max_iterations=3', computeMs: 1000 }),
    ]);

    expect(rejection(verdict).reason).toContain('nothing to preserve');
  });

  it('says a candidate failed to run rather than failed an assertion', () => {
    const verdict = decideSweep(sweep('cost', [3]), [baseline()], [
      outcome({ name: 'max_iterations=3', computeMs: 100, error: 'tail crashed' }),
    ]);

    expect(rejection(verdict).reason).toBe('every candidate failed to run: tail crashed');
  });

  it('reports an assertion failure when only some candidates errored', () => {
    const verdict = decideSweep(sweep('cost'), [baseline()], [
      outcome({ name: 'max_iterations=3', computeMs: 100, error: 'tail crashed' }),
      outcome({ name: 'max_iterations=1', computeMs: 100, assertionsHeld: false, failed: ['x'] }),
    ]);

    expect(rejection(verdict).reason).toBe('every candidate broke an assertion the base run held');
  });
});

describe('decideSweep — cost with a control arm', () => {
  function controlled(): KnobSweep {
    const base = sweep('cost', [3, 1]);
    base.variants['prompt=current'] = [];
    base.control = 'prompt=current';
    return base;
  }

  it('measures the saving against the control rather than history', () => {
    const verdict = decideSweep(controlled(), [baseline({ computeMs: 99_999 })], [
      outcome({ name: 'prompt=current', computeMs: 10_000 }),
      outcome({ name: 'max_iterations=3', computeMs: 5_000 }),
      outcome({ name: 'max_iterations=1', computeMs: 9_500 }),
    ]);

    expect(proposal(verdict).computeDelta).toBeCloseTo(0.5);
  });

  it('rejects when the control is flaky rather than crediting the knob', () => {
    const verdict = decideSweep(controlled(), [baseline()], [
      outcome({ name: 'prompt=current', assertionsHeld: false, failed: ['status_equals'] }),
      outcome({ name: 'max_iterations=3', computeMs: 1000 }),
      outcome({ name: 'max_iterations=1', computeMs: 1000 }),
    ]);

    expect(rejection(verdict).reason).toContain('make it reliable before making it cheaper');
  });

  it('never proposes the control itself', () => {
    const verdict = decideSweep(controlled(), [baseline()], [
      outcome({ name: 'prompt=current', computeMs: 10_000 }),
      outcome({ name: 'max_iterations=3', computeMs: 5_000 }),
      outcome({ name: 'max_iterations=1', computeMs: 9_800, assertionsHeld: false, failed: ['x'] }),
    ]);

    expect(proposal(verdict).to).toBe(3);
  });

  it('rejects when the control arm did not complete everywhere', () => {
    const verdict = decideSweep(controlled(), [baseline({ runId: 'a' }), baseline({ runId: 'b' })], [
      outcome({ name: 'prompt=current', computeMs: 10_000 }),
      outcome({ name: 'max_iterations=3', computeMs: 5_000 }),
      outcome({ name: 'max_iterations=3', computeMs: 5_000 }),
    ]);

    expect(rejection(verdict).reason).toContain('no cost to compare against');
  });
});

describe('decideSweep — across base runs', () => {
  it('requires a candidate to hold on every base run swept', () => {
    const verdict = decideSweep(sweep('cost', [3]), [baseline({ runId: 'a' }), baseline({ runId: 'b' })], [
      outcome({ name: 'max_iterations=3', runId: '1', computeMs: 3000 }),
      outcome({ name: 'max_iterations=3', runId: '2', computeMs: 3000, assertionsHeld: false, failed: ['x'] }),
    ]);

    expect(rejection(verdict).reason).toBe('every candidate broke an assertion the base run held');
  });

  it('ignores a candidate that did not run against every base run', () => {
    const verdict = decideSweep(sweep('cost', [3, 1]), [baseline({ runId: 'a' }), baseline({ runId: 'b' })], [
      outcome({ name: 'max_iterations=3', computeMs: 3000 }),
      outcome({ name: 'max_iterations=3', computeMs: 3000 }),
      outcome({ name: 'max_iterations=1', computeMs: 100 }),
    ]);

    expect(proposal(verdict).to).toBe(3);
  });

  it('averages a candidate over the base runs it was measured on', () => {
    const verdict = decideSweep(sweep('cost', [3]), [baseline({ runId: 'a' }), baseline({ runId: 'b' })], [
      outcome({ name: 'max_iterations=3', computeMs: 2000 }),
      outcome({ name: 'max_iterations=3', computeMs: 4000 }),
    ]);

    expect(proposal(verdict).computeDelta).toBeCloseTo(0.7);
  });

  it('names every base run it was measured on', () => {
    const verdict = decideSweep(sweep('cost', [3]), [baseline({ runId: 'a' }), baseline({ runId: 'b' })], [
      outcome({ name: 'max_iterations=3', computeMs: 2000 }),
      outcome({ name: 'max_iterations=3', computeMs: 2000 }),
    ]);

    expect(proposal(verdict).measuredOn).toEqual(['a', 'b']);
  });

  it('rejects when no candidate ran anywhere', () => {
    const verdict = decideSweep(sweep('cost'), [baseline()], []);

    expect(rejection(verdict).reason).toContain('no candidate completed');
  });

  it('rejects when there was no base run to compare against', () => {
    const verdict = decideSweep(sweep('cost'), [], [outcome({ name: 'max_iterations=3' })]);

    expect(rejection(verdict).reason).toContain('no base run');
  });
});

describe('decideSweep — correctness', () => {
  const UP = sweep('correctness', [12, 24]);

  function controlled(): KnobSweep {
    const base = sweep('correctness', [6, 12, 24]);
    base.control = 'max_iterations=6';
    return base;
  }

  it('rejects when the unchanged value also fixes the failing prefix', () => {
    const verdict = decideSweep(controlled(), [baseline({ assertionsHeld: false })], [
      outcome({ name: 'max_iterations=6' }),
      outcome({ name: 'max_iterations=12' }),
      outcome({ name: 'max_iterations=24' }),
    ]);

    expect(rejection(verdict).reason).toContain('the failure did not reproduce');
  });

  it('never proposes the control itself', () => {
    const verdict = decideSweep(controlled(), [baseline({ assertionsHeld: false })], [
      outcome({ name: 'max_iterations=6', assertionsHeld: false, failed: ['x'] }),
      outcome({ name: 'max_iterations=12' }),
      outcome({ name: 'max_iterations=24' }),
    ]);

    expect(proposal(verdict).to).toBe(12);
  });

  it('refuses to fix prefixes that already hold their assertions', () => {
    const verdict = decideSweep(UP, [baseline({ assertionsHeld: true })], [
      outcome({ name: 'max_iterations=12', computeMs: 20_000 }),
    ]);

    expect(rejection(verdict).reason).toBe(
      'every base run already holds its assertions, so a fix measured on these prefixes fixes nothing',
    );
  });

  it('proposes the cheapest value that makes every assertion hold', () => {
    const verdict = decideSweep(UP, [baseline({ assertionsHeld: false })], [
      outcome({ name: 'max_iterations=12', computeMs: 20_000 }),
      outcome({ name: 'max_iterations=24', computeMs: 40_000 }),
    ]);

    expect(proposal(verdict).to).toBe(12);
  });

  it('accepts a winner that costs more than the base run', () => {
    const verdict = decideSweep(UP, [baseline({ assertionsHeld: false, computeMs: 10_000 })], [
      outcome({ name: 'max_iterations=12', computeMs: 20_000 }),
      outcome({ name: 'max_iterations=24', computeMs: 40_000 }),
    ]);

    expect(proposal(verdict).computeDelta).toBeCloseTo(-1);
  });

  it('skips a cheaper value that did not make the assertions hold', () => {
    const verdict = decideSweep(UP, [baseline({ assertionsHeld: false })], [
      outcome({ name: 'max_iterations=12', assertionsHeld: false, failed: ['status_equals'] }),
      outcome({ name: 'max_iterations=24', computeMs: 40_000 }),
    ]);

    expect(proposal(verdict).to).toBe(24);
  });

  it('rejects when no value made the assertions hold', () => {
    const verdict = decideSweep(UP, [baseline({ assertionsHeld: false })], [
      outcome({ name: 'max_iterations=12', assertionsHeld: false, failed: ['x'] }),
      outcome({ name: 'max_iterations=24', assertionsHeld: false, failed: ['x'] }),
    ]);

    expect(rejection(verdict).reason).toBe('no candidate made every assertion hold');
  });

  it('does not require a saving, since correctness is what is being bought', () => {
    const verdict = decideSweep(UP, [baseline({ assertionsHeld: false, computeMs: 10_000 })], [
      outcome({ name: 'max_iterations=12', computeMs: 10_050 }),
    ]);

    expect(proposal(verdict).to).toBe(12);
  });
});

describe('decideSweep', () => {
  it('carries every outcome so the verdict shows its working', () => {
    const measured = [
      outcome({ name: 'max_iterations=3', computeMs: 5000 }),
      outcome({ name: 'max_iterations=1', computeMs: 100, assertionsHeld: false, failed: ['x'] }),
    ];

    const verdict = decideSweep(sweep('cost'), [baseline()], measured);

    expect(proposal(verdict).outcomes).toEqual(measured);
  });

  it('records the model the measurements were made against', () => {
    const verdict = decideSweep(sweep('cost', [3]), [baseline()], [
      outcome({ name: 'max_iterations=3', computeMs: 1000 }),
    ], 'qwen2.5:7b');

    expect(proposal(verdict).model).toBe('qwen2.5:7b');
  });

  it('falls back to an explicit unknown rather than an absent model', () => {
    const verdict = decideSweep(sweep('cost', [3]), [baseline()], [
      outcome({ name: 'max_iterations=3', computeMs: 1000 }),
    ]);

    expect(proposal(verdict).model).toBe('unknown');
  });

  it('carries the change the winner represents', () => {
    const target = sweep('cost');
    target.variants['max_iterations=3'] = [{ kind: 'config', node_id: 'boss', patch: { x: 1 } }];

    const verdict = decideSweep(target, [baseline()], [outcome({ name: 'max_iterations=3', computeMs: 1000 })]);

    expect(proposal(verdict).change).toEqual([{ kind: 'config', node_id: 'boss', patch: { x: 1 } }]);
  });
});
