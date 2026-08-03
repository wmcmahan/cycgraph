/**
 * Tests for the recording planner — verifies trajectory tags route to
 * the correct graph + tool fixture for the orchestrator suite, and that
 * memory + context-engine suites correctly delegate to their handler
 * registries.
 */

import { describe, it, expect } from 'vitest';
import {
  planForTrajectory,
  planSuite,
} from '../../src/sut/recording-planner.js';
import { loadGoldenTrajectories } from '../../src/dataset/loader.js';
import type { GoldenTrajectory, SuiteName } from '../../src/dataset/types.js';

function makeTrajectory(
  suite: SuiteName,
  tags: string[],
  overrides: Partial<GoldenTrajectory> = {},
): GoldenTrajectory {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    suite,
    description: 'test trajectory',
    input: 'test input',
    expectedOutput: '',
    tags,
    source: 'internal',
    createdAt: '2026-04-01T00:00:00Z',
    ...overrides,
  };
}

describe('planForTrajectory — orchestrator', () => {
  it('routes supervisor tag to supervisor graph', () => {
    const plan = planForTrajectory(
      'orchestrator',
      makeTrajectory('orchestrator', ['supervisor', 'routing']),
    );
    expect(plan.supported).toBe(true);
    expect(plan.graphKind).toBe('supervisor');
    expect(plan.toolKind).toBe('none');
  });

  it('routes multi-agent + delegation tags to supervisor graph', () => {
    const plan = planForTrajectory(
      'orchestrator',
      makeTrajectory('orchestrator', ['multi-agent', 'delegation']),
    );
    expect(plan.graphKind).toBe('supervisor');
  });

  it('routes branching/conditional tags to branching graph', () => {
    const plan = planForTrajectory(
      'orchestrator',
      makeTrajectory('orchestrator', ['branching', 'conditional']),
    );
    expect(plan.graphKind).toBe('branching');
    expect(plan.toolKind).toBe('none');
  });

  it('routes retry tag to retry graph with flaky_fetch by default', () => {
    const plan = planForTrajectory(
      'orchestrator',
      makeTrajectory('orchestrator', ['error', 'retry'], {
        description: 'Retry an unreliable API',
      }),
    );
    expect(plan.graphKind).toBe('retry');
    expect(plan.toolKind).toBe('flaky_fetch');
  });

  it('routes rate-limit retry to rate_limited_call fixture', () => {
    const plan = planForTrajectory(
      'orchestrator',
      makeTrajectory('orchestrator', ['error', 'retry'], {
        description: 'Retry: rate limit handling',
      }),
    );
    expect(plan.graphKind).toBe('retry');
    expect(plan.toolKind).toBe('rate_limited_call');
  });

  it('routes linear/basic tags to single-agent with web_search', () => {
    const plan = planForTrajectory(
      'orchestrator',
      makeTrajectory('orchestrator', ['linear', 'basic']),
    );
    expect(plan.graphKind).toBe('single-agent');
    expect(plan.toolKind).toBe('web_search');
  });

  it('routes no-tools tag to single-agent with no tools', () => {
    const plan = planForTrajectory(
      'orchestrator',
      makeTrajectory('orchestrator', ['linear', 'basic', 'no-tools']),
    );
    expect(plan.graphKind).toBe('single-agent');
    expect(plan.toolKind).toBe('none');
  });

  it('routes budget/limits tags to single-agent', () => {
    const plan = planForTrajectory(
      'orchestrator',
      makeTrajectory('orchestrator', ['budget', 'limits']),
    );
    expect(plan.graphKind).toBe('single-agent');
  });

  it('routes state/persistence tags to single-agent', () => {
    const plan = planForTrajectory(
      'orchestrator',
      makeTrajectory('orchestrator', ['state', 'persistence']),
    );
    expect(plan.graphKind).toBe('single-agent');
  });

  it('reports unsupported tags with a descriptive reason', () => {
    const plan = planForTrajectory(
      'orchestrator',
      makeTrajectory('orchestrator', ['some-future-tag']),
    );
    expect(plan.supported).toBe(false);
    expect(plan.skipReason).toContain('some-future-tag');
  });

  it('treats a trajectory with no tags as unsupported', () => {
    const plan = planForTrajectory(
      'orchestrator',
      makeTrajectory('orchestrator', undefined as unknown as string[]),
    );

    expect(plan.supported).toBe(false);
    expect(plan.skipReason).toContain('[]');
  });
});

describe('planForTrajectory — memory', () => {
  it('delegates to isMemoryTrajectorySupported for known tag families', () => {
    const supported = planForTrajectory(
      'memory',
      makeTrajectory('memory', ['temporal', 'validity']),
    );
    expect(supported.supported).toBe(true);

    const unsupported = planForTrajectory(
      'memory',
      makeTrajectory('memory', ['some-future-tag']),
    );
    expect(unsupported.supported).toBe(false);
  });

  it('reports a skip reason for a tagless unsupported trajectory', () => {
    const plan = planForTrajectory(
      'memory',
      makeTrajectory('memory', undefined as unknown as string[]),
    );

    expect(plan.supported).toBe(false);
    expect(plan.skipReason).toContain('No memory handler for tags []');
  });
});

describe('planForTrajectory — context-engine', () => {
  it('delegates to isContextEngineTrajectorySupported for known tag families', () => {
    const supported = planForTrajectory(
      'context-engine',
      makeTrajectory('context-engine', ['format', 'json']),
    );
    expect(supported.supported).toBe(true);
  });

  it('reports a skip reason for an unsupported context-engine trajectory', () => {
    const plan = planForTrajectory(
      'context-engine',
      makeTrajectory('context-engine', ['some-future-tag']),
    );

    expect(plan.supported).toBe(false);
    expect(plan.skipReason).toContain('No context-engine handler for tags [some-future-tag]');
  });
});

describe('planForTrajectory — integration', () => {
  it('always returns unsupported (integration has no recordable goldens)', () => {
    const plan = planForTrajectory(
      'integration',
      makeTrajectory('integration', []),
    );
    expect(plan.supported).toBe(false);
    expect(plan.skipReason).toContain('integration');
  });
});

describe('planSuite — real golden coverage', () => {
  /**
   * Runs against the actual seeded golden trajectories, locking in the
   * current routing behavior so accidental tag changes get caught.
   */

  it('classifies all orchestrator trajectories', () => {
    const trajectories = loadGoldenTrajectories('orchestrator');
    const plans = planSuite('orchestrator', trajectories);

    const supported = plans.filter(p => p.supported);
    expect(supported.length).toBe(trajectories.length);

    const kinds = new Set(plans.map(p => p.graphKind));
    expect(kinds).toEqual(new Set(['supervisor', 'branching', 'retry', 'single-agent']));
  });

  it('classifies all memory trajectories', () => {
    const trajectories = loadGoldenTrajectories('memory');
    const plans = planSuite('memory', trajectories);

    const supported = plans.filter(p => p.supported);
    expect(supported.length).toBe(trajectories.length);
  });

  it('classifies all context-engine trajectories', () => {
    const trajectories = loadGoldenTrajectories('context-engine');
    const plans = planSuite('context-engine', trajectories);

    const supported = plans.filter(p => p.supported);
    expect(supported.length).toBe(trajectories.length);
  });
});
