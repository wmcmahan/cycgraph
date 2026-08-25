/** Tests for the measure graph's pure reassembly (run/measure.ts). */

import { describe, expect, it } from 'vitest';
import { assembleOutcomes } from '../src/improve/measure.js';
import type { MeasureArm } from '../src/improve/measure.js';
import type { VariantOutcome } from '@cycgraph/evals';

const RESULT_KEY = 'fork_result';

function arm(variant: string): MeasureArm {
  return { variant, baseRunId: 'base-1', at: 'start', changes: [] };
}

function outcome(name: string): VariantOutcome {
  return { name, assertionsHeld: true, failed: [], computeMs: 100, tokens: 10 };
}

function wrap(index: number, value: VariantOutcome) {
  return { index, updates: { [RESULT_KEY]: value } };
}

describe('assembleOutcomes', () => {
  it('returns one outcome per arm in arm order', () => {
    const arms = [arm('a'), arm('b'), arm('a')];
    const wrapped = [wrap(2, outcome('a')), wrap(0, outcome('a')), wrap(1, outcome('b'))];

    const outcomes = assembleOutcomes(arms, RESULT_KEY, wrapped, []);

    expect(outcomes.map((entry) => entry.name)).toEqual(['a', 'b', 'a']);
  });

  it('turns a fan-out error into an outcome for the arm at its index', () => {
    const arms = [arm('a'), arm('b')];
    const wrapped = [wrap(0, outcome('a'))];
    const errors = [{ index: 1, error: 'worker timed out' }];

    const outcomes = assembleOutcomes(arms, RESULT_KEY, wrapped, errors);

    expect(outcomes[1]).toEqual({
      name: 'b',
      assertionsHeld: false,
      failed: [],
      computeMs: 0,
      tokens: 0,
      error: 'worker timed out',
    });
  });

  it('fills an arm the fan-out lost entirely with an error outcome', () => {
    const arms = [arm('a'), arm('b')];
    const wrapped = [wrap(0, outcome('a'))];

    const outcomes = assembleOutcomes(arms, RESULT_KEY, wrapped, []);

    expect(outcomes[1]!.error).toBe('the fan-out returned no result for this arm');
    expect(outcomes[1]!.name).toBe('b');
  });

  it('names an errored arm after its variant even without a message', () => {
    const arms = [arm('bundle')];

    const outcomes = assembleOutcomes(arms, RESULT_KEY, [], [{ index: 0 }]);

    expect(outcomes[0]!.name).toBe('bundle');
    expect(outcomes[0]!.error).toBe('worker failed without a message');
  });
});
