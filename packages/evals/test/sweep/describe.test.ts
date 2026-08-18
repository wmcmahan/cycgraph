/**
 * Tests for describeProposal and describeVerdict (src/sweep/describe.ts).
 */

import { describe, it, expect } from 'vitest';
import { describeProposal, describeVerdict } from '../../src/sweep/describe.js';
import type { SweepProposal } from '../../src/sweep/types.js';

function proposal(partial: Partial<SweepProposal> = {}): SweepProposal {
  return {
    sweepId: 'sweep:wf:boss:supervisor_config.max_iterations',
    workflow: 'wf',
    nodeId: 'boss',
    knob: 'supervisor_config.max_iterations',
    from: 6,
    to: 3,
    objective: 'cost',
    model: 'qwen2.5:7b',
    change: [],
    computeDelta: 0.23,
    tokenDelta: 0.18,
    measuredOn: ['a', 'b'],
    outcomes: [],
    ...partial,
  };
}

describe('describeProposal', () => {
  it('states the change, what it saved, and what it was measured on', () => {
    expect(describeProposal(proposal())).toBe(
      'boss.supervisor_config.max_iterations: 6 → 3 holds every assertion at '
      + '−23% execution time, −18% tokens, across 2 base run(s) on qwen2.5:7b',
    );
  });

  it('marks an increase as an increase', () => {
    const text = describeProposal(proposal({ computeDelta: -1, tokenDelta: -0.5 }));

    expect(text).toContain('+100% execution time, +50% tokens');
  });

  it('says a correctness winner made the assertions hold', () => {
    const text = describeProposal(proposal({ objective: 'correctness', from: 3, to: 12 }));

    expect(text).toContain('3 → 12 makes every assertion hold');
  });
});

describe('describeProposal — reliability', () => {
  it('states the rate comparison and its probability', () => {
    const text = describeProposal(proposal({
      knob: 'temperature',
      from: 0.7,
      to: 0,
      objective: 'reliability',
      reliability: { winnerPassed: 5, winnerOf: 5, controlPassed: 1, controlOf: 5, pValue: 5 / 210 },
    }));

    expect(text).toContain("holds assertions in 5/5 sample(s) against the control's 1/5 (p=0.024)");
  });
});

describe('describeProposal — model', () => {
  it('names the model every measurement was made against', () => {
    expect(describeProposal(proposal({ model: 'llama3:8b' }))).toContain('on llama3:8b');
  });
});

describe('describeVerdict', () => {
  it('describes a proposal', () => {
    const text = describeVerdict({ kind: 'proposal', proposal: proposal() });

    expect(text).toContain('6 → 3 holds every assertion');
  });

  it('describes a rejection by its reason', () => {
    const text = describeVerdict({
      kind: 'rejected',
      rejection: {
        sweepId: 's',
        workflow: 'wf',
        nodeId: 'boss',
        knob: 'supervisor_config.max_iterations',
        reason: 'every candidate broke an assertion the base run held',
        outcomes: [],
      },
    });

    expect(text).toBe(
      'boss.supervisor_config.max_iterations: every candidate broke an assertion the base run held',
    );
  });
});
