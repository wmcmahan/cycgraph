/**
 * Tests for the generic SUT dispatcher: deterministic suites run their real
 * library-backed SUTs end-to-end; the orchestrator SUT boundary is
 * module-mocked so graph routing and tool-fixture resolution are testable
 * without an LLM.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RecordingPlan } from '../../src/sut/recording-planner.js';
import type { SutRunResult } from '../../src/sut/types.js';
import type { GoldenTrajectory, SuiteName } from '../../src/dataset/types.js';

const runOrchestratorSut = vi.hoisted(() =>
  vi.fn(async (): Promise<SutRunResult> => ({
    output: 'mocked',
    toolCalls: [],
    durationMs: 1,
    finalMemory: {},
    status: 'completed',
  })),
);

vi.mock('../../src/sut/orchestrator-sut.js', () => ({ runOrchestratorSut }));

const { runSutDispatch } = await import('../../src/sut/dispatch.js');
const { planForTrajectory } = await import('../../src/sut/recording-planner.js');

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

function makeOrchestratorPlan(overrides: Partial<RecordingPlan> = {}): RecordingPlan {
  return {
    trajectory: makeTrajectory('orchestrator', ['single-agent'], 'What is TypeScript?'),
    supported: true,
    ...overrides,
  };
}

type CapturedSutOptions = {
  graph: { nodes: Array<{ id: string }> };
  toolResponses?: Record<string, (args: Record<string, unknown>) => unknown>;
  toolDescriptions?: Record<string, string>;
  outputKey: string;
  timeoutMs?: number;
};

describe('runSutDispatch — orchestrator graph selection', () => {
  beforeEach(() => {
    runOrchestratorSut.mockClear();
  });

  async function dispatchWith(overrides: Partial<RecordingPlan>): Promise<CapturedSutOptions> {
    const result = await runSutDispatch({
      suite: 'orchestrator',
      plan: makeOrchestratorPlan(overrides),
      model: 'claude-sonnet-4-6',
      timeoutMs: 5_000,
    });
    expect(result.status).toBe('completed');
    expect(runOrchestratorSut).toHaveBeenCalledOnce();
    return runOrchestratorSut.mock.calls[0][0] as unknown as CapturedSutOptions;
  }

  it('builds the supervisor graph for graphKind supervisor and forwards the timeout', async () => {
    const opts = await dispatchWith({ graphKind: 'supervisor' });

    expect(opts.graph.nodes.some((n) => n.id.includes('supervisor'))).toBe(true);
    expect(opts.timeoutMs).toBe(5_000);
  });

  it('builds the branching graph around its router node', async () => {
    const opts = await dispatchWith({ graphKind: 'branching' });

    expect(opts.graph.nodes.map((n) => n.id)).toContain('router');
    expect(opts.outputKey).toBeTruthy();
  });

  it('builds the retry graph with no fixtures when toolKind is unset', async () => {
    const opts = await dispatchWith({ graphKind: 'retry' });

    expect(opts.toolResponses).toBeUndefined();
    expect(opts.graph.nodes.length).toBeGreaterThan(0);
  });

  it('builds the retry graph around the resolved flaky_fetch fixture', async () => {
    const opts = await dispatchWith({ graphKind: 'retry', toolKind: 'flaky_fetch' });

    expect(Object.keys(opts.toolResponses ?? {})).toEqual(['flaky_fetch']);
  });

  it('defaults to the single-agent graph with no tools for an unset graphKind', async () => {
    const opts = await dispatchWith({});

    expect(opts.toolResponses).toBeUndefined();
    expect(opts.outputKey).toBeTruthy();
  });
});

describe('runSutDispatch — tool fixture resolution', () => {
  beforeEach(() => {
    runOrchestratorSut.mockClear();
  });

  async function fixturesFor(toolKind: RecordingPlan['toolKind']): Promise<CapturedSutOptions> {
    await runSutDispatch({
      suite: 'orchestrator',
      plan: makeOrchestratorPlan({ toolKind }),
      model: 'claude-sonnet-4-6',
    });
    return runOrchestratorSut.mock.calls[0][0] as unknown as CapturedSutOptions;
  }

  it('resolves the web_search fixture with a canned result payload', async () => {
    const { toolResponses, toolDescriptions } = await fixturesFor('web_search');

    const payload = toolResponses!.web_search({ query: 'typescript' }) as {
      query: unknown;
      results: Array<{ title: string }>;
    };
    expect(payload.query).toBe('typescript');
    expect(payload.results[0].title).toContain('TypeScript');
    expect(toolDescriptions!.web_search).toContain('Search the web');
  });

  it('resolves a fresh flaky_fetch closure that fails before succeeding', async () => {
    const { toolResponses } = await fixturesFor('flaky_fetch');
    const flaky = toolResponses!.flaky_fetch;

    const first = flaky({}) as { error?: unknown };
    const second = flaky({}) as { error?: unknown };
    const third = flaky({}) as { error?: unknown };

    expect(first.error).toBeDefined();
    expect(second.error).toBeDefined();
    expect(third.error).toBeUndefined();
  });

  it('resolves a rate_limited_call closure that rate-limits periodically', async () => {
    const { toolResponses } = await fixturesFor('rate_limited_call');
    const call = toolResponses!.rate_limited_call;

    const outcomes = [call({}), call({}), call({}), call({}), call({})] as Array<{
      error?: unknown;
    }>;

    expect(outcomes.some((o) => o.error !== undefined)).toBe(true);
    expect(outcomes.some((o) => o.error === undefined)).toBe(true);
  });
});
