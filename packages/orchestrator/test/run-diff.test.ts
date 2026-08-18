/**
 * Tests for diffRuns and formatRunDiff (src/replay/diff.ts): the comparison
 * between a recorded run and a fork of it.
 */

import { describe, it, expect } from 'vitest';
import { diffRuns, formatRunDiff } from '../src/replay/diff.js';
import { createWorkflowState } from '../src/state/state.js';
import type { WorkflowState } from '../src/state/state.js';

function run(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return {
    ...createWorkflowState({
      workflowId: '22222222-2222-4222-8222-222222222222',
      goal: 'g',
    }),
    ...overrides,
  };
}

describe('diffRuns', () => {
  it('reports no divergence for identical paths', () => {
    const path = ['a', 'b', 'c'];

    const diff = diffRuns(run({ visited_nodes: path }), run({ visited_nodes: path }));

    expect(diff.divergence).toBeNull();
    expect(diff.path.inserted).toEqual([]);
    expect(diff.path.skipped).toEqual([]);
  });

  it('locates the first position where the paths differ', () => {
    const diff = diffRuns(
      run({ visited_nodes: ['a', 'b', 'c'] }),
      run({ visited_nodes: ['a', 'x', 'c'] }),
    );

    expect(diff.divergence).toMatchObject({ index: 1, base: 'b', variant: 'x' });
  });

  it('reports a node the variant added as inserted, not as a rewrite of the tail', () => {
    const diff = diffRuns(
      run({ visited_nodes: ['a', 'c'] }),
      run({ visited_nodes: ['a', 'b', 'c'] }),
    );

    expect(diff.path.inserted).toEqual(['b']);
    expect(diff.path.skipped).toEqual([]);
  });

  it('reports a node the variant skipped', () => {
    const diff = diffRuns(
      run({ visited_nodes: ['a', 'b', 'c'] }),
      run({ visited_nodes: ['a', 'c'] }),
    );

    expect(diff.path.skipped).toEqual(['b']);
    expect(diff.path.inserted).toEqual([]);
  });

  it('aligns a repeated node against its own occurrences', () => {
    const diff = diffRuns(
      run({ visited_nodes: ['a', 'b', 'a', 'b'] }),
      run({ visited_nodes: ['a', 'b'] }),
    );

    expect(diff.path.skipped).toEqual(['a', 'b']);
  });

  it('classifies added, removed and changed memory keys', () => {
    const diff = diffRuns(
      run({ memory: { kept: 1, dropped: 2, edited: 'before' } }),
      run({ memory: { kept: 1, edited: 'after', fresh: 3 } }),
    );

    expect(diff.memory).toEqual({
      dropped: { change: 'removed', bytesDelta: -1, taintChanged: false },
      edited: { change: 'changed', bytesDelta: -1, taintChanged: false },
      fresh: { change: 'added', bytesDelta: 1, taintChanged: false },
    });
  });

  it('omits memory keys whose values are unchanged', () => {
    const diff = diffRuns(
      run({ memory: { same: { nested: true } } }),
      run({ memory: { same: { nested: true } } }),
    );

    expect(diff.memory).toEqual({});
  });

  it('flags a key whose taint status changed', () => {
    const base = run({ memory: { data: 'x' } });
    const variant = run({
      memory: { data: 'y' },
      taint_registry: { data: { source: 'mcp', node_id: 'fetch', bytes: 1 } } as WorkflowState['taint_registry'],
    });

    expect(diffRuns(base, variant).memory.data.taintChanged).toBe(true);
  });

  it('reports terminal status on both sides', () => {
    const diff = diffRuns(run({ status: 'failed' }), run({ status: 'completed' }));

    expect(diff.terminal).toMatchObject({ base: 'failed', variant: 'completed' });
  });

  it('reports the iteration difference', () => {
    const diff = diffRuns(run({ iteration_count: 3 }), run({ iteration_count: 5 }));

    expect(diff.terminal.iterationsDelta).toBe(2);
  });

  it('leaves wall clock null when a run never started', () => {
    const diff = diffRuns(run(), run());

    expect(diff.terminal.wallClockDeltaMs).toBeNull();
  });

  it('measures wall clock from start to last update', () => {
    const started = new Date('2026-01-01T00:00:00.000Z');
    const base = run({ started_at: started, updated_at: new Date('2026-01-01T00:00:10.000Z') });
    const variant = run({ started_at: started, updated_at: new Date('2026-01-01T00:00:04.000Z') });

    expect(diffRuns(base, variant).terminal.wallClockDeltaMs).toBe(-6000);
  });

  it('separates cost the tail incurred from cost the prefix carried', () => {
    const diff = diffRuns(
      run({ total_cost_usd: 1.0 }),
      run({ total_cost_usd: 1.5 }),
      { prefixState: run({ total_cost_usd: 0.8 }) },
    );

    expect(diff.cost.usdDelta).toBeCloseTo(0.5);
    expect(diff.cost.incurredUsd).toBeCloseTo(0.7);
  });

  it('reports a node the variant spent on that the base never ran', () => {
    const breakdown = (cost: number) => ({ input_tokens: 0, output_tokens: 0, cost_usd: cost, calls: 1 });

    const diff = diffRuns(run(), run({ node_breakdown: { fresh: breakdown(0.2) } }));

    expect(diff.cost.perNode.fresh).toBeCloseTo(0.2);
  });

  it('measures a non-string memory value by its serialized size', () => {
    const diff = diffRuns(run(), run({ memory: { obj: { a: 1 } } }));

    expect(diff.memory.obj.bytesDelta).toBe(7);
  });

  it('reports per-node spend differences and omits unchanged nodes', () => {
    const breakdown = (cost: number) => ({ input_tokens: 0, output_tokens: 0, cost_usd: cost, calls: 1 });
    const diff = diffRuns(
      run({ node_breakdown: { research: breakdown(0.1), write: breakdown(0.2) } }),
      run({ node_breakdown: { research: breakdown(0.1), write: breakdown(0.5) } }),
    );

    expect(Object.keys(diff.cost.perNode)).toEqual(['write']);
    expect(diff.cost.perNode.write).toBeCloseTo(0.3);
  });

  it('computes the score delta when scores are supplied', () => {
    const diff = diffRuns(run(), run(), { scores: { base: 0.53, variant: 0.71 } });

    expect(diff.score).toMatchObject({ base: 0.53, variant: 0.71 });
    expect(diff.score?.delta).toBeCloseTo(0.18);
  });

  it('omits the score entirely when none are supplied', () => {
    expect(diffRuns(run(), run()).score).toBeUndefined();
  });
});

describe('formatRunDiff', () => {
  it('shows the previous status when the terminal state changed', () => {
    const text = formatRunDiff(diffRuns(run({ status: 'failed' }), run({ status: 'completed' })));

    expect(text).toContain('completed          was failed');
  });

  it('shows a single status when it did not change', () => {
    const text = formatRunDiff(diffRuns(run({ status: 'completed' }), run({ status: 'completed' })));

    expect(text).toContain('status    completed');
    expect(text).not.toContain('was');
  });

  it('marks a substituted node in the path', () => {
    const text = formatRunDiff(diffRuns(
      run({ visited_nodes: ['a', 'b'] }),
      run({ visited_nodes: ['a', 'x'] }),
    ));

    expect(text).toContain('a → b→x');
  });

  it('marks inserted and skipped nodes in the path', () => {
    const text = formatRunDiff(diffRuns(
      run({ visited_nodes: ['a', 'b'] }),
      run({ visited_nodes: ['a', 'c', 'b'] }),
    ));

    expect(text).toContain('+c');
  });

  it('points at the divergence position', () => {
    const text = formatRunDiff(diffRuns(
      run({ visited_nodes: ['a', 'b'] }),
      run({ visited_nodes: ['a', 'x'] }),
    ));

    expect(text).toContain('diverged here');
  });

  it('renders memory changes with byte deltas', () => {
    const text = formatRunDiff(diffRuns(
      run({ memory: { draft: 'ab' } }),
      run({ memory: { draft: 'abcd' } }),
    ));

    expect(text).toContain('~draft (+2B)');
  });

  it('renders the score line when scored', () => {
    const text = formatRunDiff(diffRuns(run(), run(), { scores: { base: 0.5, variant: 0.8 } }));

    expect(text).toContain('0.800 vs 0.500 (+0.300)');
  });

  it('lists suppressed side effects', () => {
    const text = formatRunDiff(diffRuns(run(), run(), {
      suppressedEffects: [{ nodeId: 'fetch', kind: 'tool', reason: 'served from the recording' }],
    }));

    expect(text).toContain('blocked   fetch (tool): served from the recording');
  });

  it('marks a removed key with its byte loss', () => {
    const text = formatRunDiff(diffRuns(run({ memory: { gone: 'abc' } }), run()));

    expect(text).toContain('-gone (-3B)');
  });

  it('flags a key whose taint status moved', () => {
    const base = run({ memory: { data: 'x' } });
    const variant = run({
      memory: { data: 'y' },
      taint_registry: { data: { source: 'mcp', node_id: 'f', bytes: 1 } } as WorkflowState['taint_registry'],
    });

    expect(formatRunDiff(diffRuns(base, variant))).toContain('[taint]');
  });

  it('omits a byte delta when the size did not move', () => {
    const text = formatRunDiff(diffRuns(
      run({ memory: { k: 'ab' } }),
      run({ memory: { k: 'cd' } }),
    ));

    expect(text).toContain('~k');
    expect(text).not.toContain('B)');
  });

  it('signs a negative token delta without a plus', () => {
    const text = formatRunDiff(diffRuns(
      run({ total_tokens_used: 100 }),
      run({ total_tokens_used: 40 }),
    ));

    expect(text).toContain('-60 tokens');
  });

  it('signs a negative score delta', () => {
    const text = formatRunDiff(diffRuns(run(), run(), { scores: { base: 0.8, variant: 0.5 } }));

    expect(text).toContain('(-0.300)');
  });

  it('points at a divergence in the first position without padding', () => {
    const text = formatRunDiff(diffRuns(
      run({ visited_nodes: ['a'] }),
      run({ visited_nodes: ['b'] }),
    ));

    expect(text).toContain('^ diverged here');
  });

  it('renders a path step the variant dropped', () => {
    const text = formatRunDiff(diffRuns(
      run({ visited_nodes: ['a', 'b', 'c'] }),
      run({ visited_nodes: ['a', 'c'] }),
    ));

    expect(text).toContain('-b');
  });

  it('puts a caller header on the first line', () => {
    const text = formatRunDiff(diffRuns(run(), run()), 'fork abc of def');

    expect(text.split('\n')[0]).toBe('fork abc of def');
  });
});
