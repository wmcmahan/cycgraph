/**
 * Tests for the combination stage (src/sweep/combine.ts): which winners
 * compose, and what the composed measurement supports.
 */

import { describe, it, expect } from 'vitest';
import { decideCombination, planCombination } from '../../src/sweep/combine.js';
import type { CombinationPlan } from '../../src/sweep/combine.js';
import type { Change } from '@cycgraph/orchestrator';
import type { KnobSweep, SweepProposal, SweepVerdict } from '../../src/sweep/types.js';
import { outcome } from './helpers.js';

function sweepOf(partial: Partial<KnobSweep> & Pick<KnobSweep, 'knob'>): KnobSweep {
  return {
    id: `sweep:wf:boss:${partial.knob}`,
    workflow: 'wf',
    nodeId: 'boss',
    current: 6,
    objective: 'cost',
    reason: 'r',
    variants: {},
    ...partial,
  };
}

function proposalOf(
  partial: Partial<SweepProposal> & Pick<SweepProposal, 'knob'>,
): SweepVerdict {
  return {
    kind: 'proposal',
    proposal: {
      sweepId: `sweep:wf:boss:${partial.knob}`,
      workflow: 'wf',
      nodeId: 'boss',
      from: 6,
      to: 3,
      objective: 'cost',
      model: 'm',
      change: [],
      computeDelta: 0.2,
      tokenDelta: 0.2,
      measuredOn: ['a'],
      outcomes: [],
      ...partial,
    },
  };
}

function rejected(knob: string): SweepVerdict {
  return {
    kind: 'rejected',
    rejection: { sweepId: `s:${knob}`, workflow: 'wf', nodeId: 'boss', knob, reason: 'r', outcomes: [] },
  };
}

const ITERATIONS: Change = { kind: 'config', node_id: 'boss', patch: { supervisor_config: { max_iterations: 3 } } };
const TEMPERATURE: Change = { kind: 'temperature', target: 'boss', temperature: 0.35 };
const PROMPT: Change = { kind: 'prompt', target: 'boss', system_prompt: 'leaner' };

function plan(partial: Partial<CombinationPlan> = {}): CombinationPlan {
  return {
    constituents: [
      { knob: 'supervisor_config.max_iterations', nodeId: 'boss', computeDelta: 0.2 },
      { knob: 'prompt', nodeId: 'boss', computeDelta: 0.1 },
    ],
    changes: [ITERATIONS, PROMPT],
    samples: 5,
    ...partial,
  };
}

describe('planCombination', () => {
  it('composes two clean-prefix winners', () => {
    const result = planCombination(
      [sweepOf({ knob: 'supervisor_config.max_iterations' }), sweepOf({ knob: 'prompt', samples: 5 })],
      [proposalOf({ knob: 'supervisor_config.max_iterations', change: [ITERATIONS] }), proposalOf({ knob: 'prompt', change: [PROMPT] })],
    );

    expect(result).toMatchObject({ changes: [ITERATIONS, PROMPT], samples: 5 });
  });

  it('produces nothing for a single proposal', () => {
    const result = planCombination(
      [sweepOf({ knob: 'prompt' }), sweepOf({ knob: 'temperature' })],
      [proposalOf({ knob: 'prompt', change: [PROMPT] }), rejected('temperature')],
    );

    expect(result).toBeUndefined();
  });

  it('excludes a winner measured on failing prefixes', () => {
    const result = planCombination(
      [
        sweepOf({ knob: 'supervisor_config.max_iterations', objective: 'correctness', prefixes: 'failing' }),
        sweepOf({ knob: 'prompt' }),
        sweepOf({ knob: 'temperature' }),
      ],
      [
        proposalOf({ knob: 'supervisor_config.max_iterations', change: [ITERATIONS] }),
        proposalOf({ knob: 'prompt', change: [PROMPT] }),
        proposalOf({ knob: 'temperature', change: [TEMPERATURE] }),
      ],
    );

    expect(result).toMatchObject({ changes: [PROMPT, TEMPERATURE] });
  });

  it('refuses winners whose changes claim the same thing', () => {
    const result = planCombination(
      [sweepOf({ knob: 'prompt' }), sweepOf({ knob: 'prompt2' })],
      [proposalOf({ knob: 'prompt', change: [PROMPT] }), proposalOf({ knob: 'prompt2', change: [PROMPT] })],
    );

    expect(result).toMatchObject({ skipped: expect.stringContaining('cannot compose') });
  });

  it('samples every arm as much as the most-sampled constituent', () => {
    const result = planCombination(
      [sweepOf({ knob: 'supervisor_config.max_iterations' }), sweepOf({ knob: 'temperature', samples: 5 })],
      [
        proposalOf({ knob: 'supervisor_config.max_iterations', change: [ITERATIONS] }),
        proposalOf({ knob: 'temperature', change: [TEMPERATURE] }),
      ],
    );

    expect(result).toMatchObject({ samples: 5 });
  });

  it('records each constituent and its claimed saving', () => {
    const result = planCombination(
      [sweepOf({ knob: 'supervisor_config.max_iterations' }), sweepOf({ knob: 'prompt' })],
      [
        proposalOf({ knob: 'supervisor_config.max_iterations', change: [ITERATIONS], computeDelta: 0.23 }),
        proposalOf({ knob: 'prompt', change: [PROMPT], computeDelta: 0.12 }),
      ],
    );

    expect(result).toMatchObject({
      constituents: [
        { knob: 'supervisor_config.max_iterations', computeDelta: 0.23 },
        { knob: 'prompt', computeDelta: 0.12 },
      ],
    });
  });
});

describe('decideCombination', () => {
  function arm(name: string, ms: number, held = true) {
    return outcome({ name, computeMs: ms, assertionsHeld: held, failed: held ? [] : ['status_equals'] });
  }

  it('says apply together when the bundle holds and matches the best single', () => {
    const verdict = decideCombination(
      plan(),
      [arm('control', 10_000), arm('control', 10_000)],
      [arm('bundle', 7_500), arm('bundle', 7_500)],
    );

    expect(verdict.decision).toBe('combine');
    expect(verdict.computeDelta).toBeCloseTo(0.25);
  });

  it('reports synergy as a saving beyond the best single', () => {
    const verdict = decideCombination(
      plan(),
      [arm('control', 10_000)],
      [arm('bundle', 6_000)],
    );

    expect(verdict.decision).toBe('combine');
    expect(verdict.computeDelta).toBeGreaterThan(verdict.bestSingleDelta);
  });

  it('calls interference when the bundle falls well short of the best single', () => {
    const verdict = decideCombination(
      plan({ constituents: [
        { knob: 'supervisor_config.max_iterations', nodeId: 'boss', computeDelta: 0.4 },
        { knob: 'prompt', nodeId: 'boss', computeDelta: 0.1 },
      ] }),
      [arm('control', 10_000)],
      [arm('bundle', 9_500)],
    );

    expect(verdict.decision).toBe('interference');
    expect(verdict.reason).toContain('boss.supervisor_config.max_iterations alone');
  });

  it('tolerates the bundle trailing the best single within sampling noise', () => {
    const verdict = decideCombination(
      plan({ constituents: [
        { knob: 'supervisor_config.max_iterations', nodeId: 'boss', computeDelta: 0.3 },
        { knob: 'prompt', nodeId: 'boss', computeDelta: 0.1 },
      ] }),
      [arm('control', 10_000)],
      [arm('bundle', 7_500)],
    );

    expect(verdict.decision).toBe('combine');
  });

  it('says do not combine when the bundle breaks an assertion any winner preserved', () => {
    const verdict = decideCombination(
      plan(),
      [arm('control', 10_000)],
      [arm('bundle', 5_000), arm('bundle', 5_000, false)],
    );

    expect(verdict.decision).toBe('broken');
    expect(verdict.reason).toContain('apply one, not both');
  });

  it('treats an errored bundle sample as broken', () => {
    const verdict = decideCombination(
      plan(),
      [arm('control', 10_000)],
      [outcome({ name: 'bundle', computeMs: 0, assertionsHeld: false, failed: [], error: 'tail crashed' })],
    );

    expect(verdict.decision).toBe('broken');
    expect(verdict.reason).toContain('(errored)');
  });

  it('refuses a verdict when either arm went unmeasured', () => {
    const verdict = decideCombination(plan(), [], [arm('bundle', 5_000)]);

    expect(verdict.decision).toBe('broken');
    expect(verdict.reason).toContain('not measured on both arms');
  });

  it('carries both arms for the report to show its working', () => {
    const control = [arm('control', 10_000)];
    const bundle = [arm('bundle', 7_000)];

    const verdict = decideCombination(plan(), control, bundle);

    expect(verdict.outcomes).toEqual([...control, ...bundle]);
  });
});
