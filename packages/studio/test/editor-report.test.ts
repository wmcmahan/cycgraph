/**
 * Tests for how an editing session reports itself when it produced no
 * report — the iteration cap, or a final turn that called tools and said
 * nothing.
 */

import { describe, it, expect } from 'vitest';
import { editInstructionFor } from '../src/improve/editor.js';
import type { ProposalRecord } from '../src/improve/proposals.js';

const record = {
  id: 'p1',
  workflow: 'flow',
  nodeId: 'boss',
  knob: 'max_iterations',
  from: 8,
  to: 1,
  change: [{ kind: 'config', node_id: 'boss', patch: { max_iterations: 1 } }],
  computeDelta: 0.5,
  tokenDelta: 0.5,
  model: 'test',
  status: 'trial',
  statusChangedAt: '2026-08-23T00:00:00.000Z',
  measuredOn: [],
  createdAt: '2026-08-23T00:00:00.000Z',
} as unknown as ProposalRecord;

describe('editInstructionFor', () => {
  it('names the file to edit when the catalog knows it', () => {
    const instruction = editInstructionFor(record, 'graphs/order-flow.ts');

    expect(instruction).toContain("defined in 'graphs/order-flow.ts'");
    expect(instruction).toContain('do not search for another');
  });

  it('falls back to a search hint when the file is unknown', () => {
    const instruction = editInstructionFor(record);

    expect(instruction).toContain('A good starting search');
  });
});
