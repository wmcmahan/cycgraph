/**
 * Tests for the generic SUT dispatcher.
 *
 * Only the deterministic-suite paths are exercised end-to-end here —
 * those run real library calls in <10ms and don't need a network. The
 * orchestrator path is verified at the level of "dispatch returns
 * something" (a real LLM call would land here) because hitting an
 * actual model in unit tests is out of scope.
 */

import { describe, it, expect } from 'vitest';
import { runSutDispatch } from '../../src/sut/dispatch.js';
import { planForTrajectory } from '../../src/sut/recording-planner.js';
import type { GoldenTrajectory, SuiteName } from '../../src/dataset/types.js';

function makeTrajectory(
  suite: SuiteName,
  tags: string[],
  input: string,
  overrides: Partial<GoldenTrajectory> = {},
): GoldenTrajectory {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    suite,
    description: 'test trajectory',
    input,
    expectedOutput: '',
    tags,
    source: 'internal',
    createdAt: '2026-04-01T00:00:00Z',
    ...overrides,
  };
}

describe('runSutDispatch — memory suite', () => {
  it('dispatches segmentation trajectories to the memory SUT', async () => {
    const trajectory = makeTrajectory(
      'memory',
      ['segmentation', 'episodes'],
      JSON.stringify([
        { role: 'user', content: 'Hello', timestamp: '2026-01-01T10:00:00Z' },
        { role: 'assistant', content: 'Hi', timestamp: '2026-01-01T10:01:00Z' },
      ]),
    );
    const plan = planForTrajectory('memory', trajectory);
    const result = await runSutDispatch({
      suite: 'memory',
      plan,
      model: 'irrelevant',
    });

    expect(result.status).toBe('completed');
    expect(result.toolCalls).toEqual([]);
    const parsed = JSON.parse(result.output) as { episodes: number };
    expect(parsed.episodes).toBe(1);
  });

  it('dispatches subgraph trajectories to the seeded fixture handler', async () => {
    const trajectory = makeTrajectory(
      'memory',
      ['subgraph', 'graph'],
      JSON.stringify({ seed_entities: ['e-alice'], maxHops: 1 }),
    );
    const plan = planForTrajectory('memory', trajectory);
    const result = await runSutDispatch({
      suite: 'memory',
      plan,
      model: 'irrelevant',
    });

    expect(result.status).toBe('completed');
    const parsed = JSON.parse(result.output) as { entities: string[] };
    expect(parsed.entities).toContain('e-alice');
  });
});

describe('runSutDispatch — context-engine suite', () => {
  it('dispatches format trajectories to the context-engine SUT', async () => {
    const trajectory = makeTrajectory(
      'context-engine',
      ['format', 'json'],
      JSON.stringify([{ name: 'Alice', score: 92 }]),
    );
    const plan = planForTrajectory('context-engine', trajectory);
    const result = await runSutDispatch({
      suite: 'context-engine',
      plan,
      model: 'irrelevant',
    });

    expect(result.status).toBe('completed');
    expect(result.toolCalls).toEqual([]);
    const parsed = JSON.parse(result.output) as { compressed: string };
    expect(parsed.compressed).toContain('Alice');
  });

  it('dispatches incremental-cache trajectories', async () => {
    const trajectory = makeTrajectory(
      'context-engine',
      ['incremental', 'cache'],
      JSON.stringify({ turn1: 'A', turn2: 'A' }),
    );
    const plan = planForTrajectory('context-engine', trajectory);
    const result = await runSutDispatch({
      suite: 'context-engine',
      plan,
      model: 'irrelevant',
    });

    expect(result.status).toBe('completed');
    const parsed = JSON.parse(result.output) as {
      turn1: { fresh: number };
      turn2: { cached: number };
    };
    expect(parsed.turn1.fresh).toBe(1);
    expect(parsed.turn2.cached).toBe(1);
  });
});

describe('runSutDispatch — error paths', () => {
  it('returns failed status for an unknown suite', async () => {
    const trajectory = makeTrajectory('memory', ['temporal', 'validity'], '[]');
    const plan = planForTrajectory('memory', trajectory);
    const result = await runSutDispatch({
      suite: 'unknown' as SuiteName,
      plan,
      model: 'irrelevant',
    });

    expect(result.status).toBe('failed');
    expect(result.error).toContain('No SUT');
  });

  it('surfaces handler errors as failed status', async () => {
    const trajectory = makeTrajectory(
      'memory',
      ['segmentation', 'episodes'],
      'not valid json',
    );
    const plan = planForTrajectory('memory', trajectory);
    const result = await runSutDispatch({
      suite: 'memory',
      plan,
      model: 'irrelevant',
    });

    expect(result.status).toBe('failed');
    expect(result.error).toBeDefined();
  });
});

describe('runSutDispatch — fixture isolation', () => {
  it('produces independent results across calls (no shared state)', async () => {
    const trajectory = makeTrajectory(
      'memory',
      ['temporal', 'validity'],
      JSON.stringify([
        { content: 'A', valid_from: '2025-01-01' },
      ]),
    );
    const plan = planForTrajectory('memory', trajectory);

    const a = await runSutDispatch({ suite: 'memory', plan, model: 'x' });
    const b = await runSutDispatch({ suite: 'memory', plan, model: 'x' });

    expect(a.status).toBe('completed');
    expect(b.status).toBe('completed');
    expect(a.output).toBe(b.output);
  });
});
