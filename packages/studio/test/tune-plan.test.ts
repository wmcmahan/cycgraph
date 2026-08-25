/**
 * Tests for the tune pass planner (src/run/tune-plan.ts): pass sequencing,
 * arm specs, and progress folding — the sweep loops as a pure state machine.
 */

import { describe, it, expect } from 'vitest';
import {
  applyPass,
  assembleOutcome,
  initialProgress,
  nextPass,
  passSpec,
} from '../src/improve/tune-plan.js';
import type { Pass, SenseResult, SweepPlanData, TuneProgress } from '../src/improve/tune-plan.js';
import type { KnobSweep, VariantOutcome } from '@cycgraph/evals';

const CHANGE_KEEP = [{ kind: 'config' as const, node_id: 'boss', patch: { supervisor_config: { max_iterations: 6 } } }];
const CHANGE_CUT = [{ kind: 'config' as const, node_id: 'boss', patch: { supervisor_config: { max_iterations: 3 } } }];

function sweep(id: string): KnobSweep {
  return {
    id: `sweep:wf:${id}`,
    workflow: 'wf',
    nodeId: id,
    knob: 'supervisor_config.max_iterations',
    current: 6,
    objective: 'cost',
    reason: 'test',
    control: 'max_iterations=6',
    variants: { 'max_iterations=6': CHANGE_KEEP, 'max_iterations=3': CHANGE_CUT },
  };
}

function data(id: string, overrides: Partial<SweepPlanData> = {}): SweepPlanData {
  return {
    sweep: sweep(id),
    samples: 1,
    baseRunIds: ['base-1', 'base-2'],
    holdoutRunIds: [],
    baselines: [
      { runId: 'base-1', assertionsHeld: true, computeMs: 20000, tokens: 2000 },
      { runId: 'base-2', assertionsHeld: true, computeMs: 21000, tokens: 2100 },
    ],
    heldOutBaselines: [],
    ...overrides,
  };
}

function sense(sweepData: SweepPlanData[], overrides: Partial<SenseResult> = {}): SenseResult {
  return {
    outcome: {
      workflow: 'wf',
      baseRunIds: ['base-1', 'base-2'],
      sweeps: sweepData.map((d) => d.sweep),
      verdicts: [],
      estimates: [],
      forks: 0,
      model: 'qwen2.5:7b',
    },
    sweepData,
    cleanBaseRunIds: ['base-1', 'base-2'],
    dryRun: false,
    reuse: false,
    noCombine: false,
    ...overrides,
  };
}

function outcome(name: string, computeMs: number): VariantOutcome {
  return { name, assertionsHeld: true, failed: [], computeMs, tokens: 1000 };
}

const NO_SPEND = { forks: 0, consumed: [] };

describe('nextPass', () => {
  it('runs main passes in sweep order', () => {
    const s = sense([data('boss'), data('scribe')]);

    expect(nextPass(s, initialProgress())).toEqual({ kind: 'main', sweepIndex: 0 });
    expect(nextPass(s, { ...initialProgress(), nextSweepIndex: 1 })).toEqual({ kind: 'main', sweepIndex: 1 });
  });

  it('runs a pending validation before the next sweep', () => {
    const s = sense([data('boss'), data('scribe')]);
    const narrowed = sweep('boss');
    const progress: TuneProgress = {
      ...initialProgress(),
      nextSweepIndex: 1,
      pendingValidation: { sweepIndex: 0, narrowed },
    };

    expect(nextPass(s, progress)).toEqual({ kind: 'validate', sweepIndex: 0, narrowed });
  });

  it('is done immediately when sensing skipped or dry-ran', () => {
    const skipped = sense([data('boss')]);
    skipped.outcome.skipped = 'nothing motivates a knob';

    expect(nextPass(skipped, initialProgress())).toBeUndefined();
    expect(nextPass(sense([data('boss')], { dryRun: true }), initialProgress())).toBeUndefined();
  });

  it('never plans a combination when opted out', () => {
    const s = sense([data('boss')], { noCombine: true });
    const progress = { ...initialProgress(), nextSweepIndex: 1 };

    expect(nextPass(s, progress)).toBeUndefined();
  });

  it('ends without a combination pass when fewer than two sweeps propose', () => {
    const s = sense([data('boss')]);
    const progress = { ...initialProgress(), nextSweepIndex: 1 };

    expect(nextPass(s, progress)).toBeUndefined();
  });
});

describe('passSpec', () => {
  it('spreads a main pass over every base and variant', () => {
    const spec = passSpec(sense([data('boss')]), { kind: 'main', sweepIndex: 0 });

    expect(spec).toHaveLength(4);
    expect(spec.map((d) => `${d.baseRunId}:${d.variant}`)).toEqual([
      'base-1:max_iterations=6', 'base-1:max_iterations=3', 'base-2:max_iterations=6', 'base-2:max_iterations=3',
    ]);
    expect(spec[0]!.at).toEqual({ beforeNode: 'boss', occurrence: 1 });
  });

  it('spreads a validation pass over the holdout only', () => {
    const d = data('boss', { holdoutRunIds: ['held-1'] });
    const narrowed = { ...d.sweep, variants: { 'max_iterations=6': CHANGE_KEEP, 'max_iterations=3': CHANGE_CUT } };

    const spec = passSpec(sense([d]), { kind: 'validate', sweepIndex: 0, narrowed });

    expect(spec.map((s) => s.baseRunId)).toEqual(['held-1', 'held-1']);
    expect(spec[0]!.labelPrefix).toMatch(/^validate /);
  });

  it('forks a combination pass from the start on the clean bases', () => {
    const pass: Pass = {
      kind: 'combine',
      plan: { constituents: [{ knob: 'k', nodeId: 'boss', computeDelta: 0.4 }], changes: CHANGE_CUT, samples: 2 } as never,
      bundleSweep: { ...sweep('boss'), variants: { control: [], bundle: CHANGE_CUT } },
    };

    const spec = passSpec(sense([data('boss')]), pass);

    expect(spec).toHaveLength(4);
    expect(spec.every((d) => d.at === 'start')).toBe(true);
    expect(spec.every((d) => d.samples === 2)).toBe(true);
  });
});

describe('applyPass', () => {
  it('accumulates a verdict and advances to the next sweep', () => {
    const s = sense([data('boss'), data('scribe')]);

    const progress = applyPass(s, initialProgress(), { kind: 'main', sweepIndex: 0 }, [
      outcome('max_iterations=6', 20000), outcome('max_iterations=6', 21000),
      outcome('max_iterations=3', 20000), outcome('max_iterations=3', 21000),
    ], { forks: 4, consumed: ['a'] });

    expect(progress.verdicts).toHaveLength(1);
    expect(progress.nextSweepIndex).toBe(1);
    expect(progress.forks).toBe(4);
    expect(progress.consumed).toEqual(['a']);
  });

  it('queues a validation only when a proposal has held-out bases', () => {
    const winner = [
      outcome('max_iterations=6', 20000), outcome('max_iterations=6', 21000),
      outcome('max_iterations=3', 9000), outcome('max_iterations=3', 9500),
    ];
    const withHoldout = sense([data('boss', { holdoutRunIds: ['held-1'], heldOutBaselines: [] })]);
    const withoutHoldout = sense([data('boss')]);

    const queued = applyPass(withHoldout, initialProgress(), { kind: 'main', sweepIndex: 0 }, winner, NO_SPEND);
    const unqueued = applyPass(withoutHoldout, initialProgress(), { kind: 'main', sweepIndex: 0 }, winner, NO_SPEND);

    expect(queued.verdicts[0]!.kind).toBe('proposal');
    expect(queued.pendingValidation?.sweepIndex).toBe(0);
    expect(unqueued.pendingValidation).toBeUndefined();
  });

  it('clears the pending validation once it decides', () => {
    const d = data('boss', { holdoutRunIds: ['held-1'] });
    const s = sense([d]);
    const progress: TuneProgress = {
      ...initialProgress(),
      nextSweepIndex: 1,
      pendingValidation: { sweepIndex: 0, narrowed: d.sweep },
    };

    const next = applyPass(s, progress, { kind: 'validate', sweepIndex: 0, narrowed: d.sweep }, [
      outcome('max_iterations=6', 20000), outcome('max_iterations=3', 9000),
    ], NO_SPEND);

    expect(next.pendingValidation).toBeUndefined();
    expect(Object.keys(next.validations)).toEqual(['sweep:wf:boss']);
  });

  it('splits combination outcomes by arm name', () => {
    const s = sense([data('boss')]);
    const pass: Pass = {
      kind: 'combine',
      plan: { constituents: [{ knob: 'k', nodeId: 'boss', computeDelta: 0.4 }], changes: CHANGE_CUT, samples: 1 } as never,
      bundleSweep: { ...sweep('boss'), variants: { control: [], bundle: CHANGE_CUT } },
    };

    const next = applyPass(s, initialProgress(), pass, [
      outcome('control', 20000), outcome('bundle', 12000),
    ], NO_SPEND);

    expect(next.combinationConsidered).toBe(true);
    expect(next.combination && 'verdict' in next.combination).toBe(true);
  });
});

describe('assembleOutcome', () => {
  it('carries verdicts, validations, and fork spend into the outcome', () => {
    const s = sense([data('boss')]);
    const progress: TuneProgress = {
      ...initialProgress(),
      verdicts: [{ kind: 'rejected', rejection: { sweepId: 'x', workflow: 'wf', nodeId: 'boss', knob: 'k', reason: 'r', outcomes: [] } }],
      forks: 7,
      nextSweepIndex: 1,
    };

    const out = assembleOutcome(s, progress);

    expect(out.forks).toBe(7);
    expect(out.verdicts).toHaveLength(1);
    expect(out.validations).toBeUndefined();
  });
});
