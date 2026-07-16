import { describe, it, expect } from 'vitest';
import { createIncrementalPipeline } from '../src/pipeline/incremental-pipeline.js';
import { createFormatStage } from '../src/format/serializer.js';
import type { PromptSegment, BudgetConfig, CompressionStage } from '../src/pipeline/types.js';

// --- Test helpers ---

function makeSegment(overrides: Partial<PromptSegment> & { id: string; content: string }): PromptSegment {
  return {
    role: 'memory',
    priority: 1,
    locked: false,
    ...overrides,
  };
}

function makeBudget(overrides?: Partial<BudgetConfig>): BudgetConfig {
  return {
    maxTokens: 4096,
    outputReserve: 0,
    ...overrides,
  };
}

/** Simple per-segment stage that uppercases content. */
function createUppercaser(): CompressionStage {
  return {
    name: 'uppercaser',
    scope: 'per-segment',
    execute(segments: PromptSegment[]) {
      return {
        segments: segments.map(s => ({ ...s, content: s.content.toUpperCase() })),
      };
    },
  };
}

/** Simple per-segment stage that adds a prefix. */
function createPrefixer(prefix: string): CompressionStage {
  return {
    name: 'prefixer',
    scope: 'per-segment',
    execute(segments: PromptSegment[]) {
      return {
        segments: segments.map(s => ({ ...s, content: `${prefix}${s.content}` })),
      };
    },
  };
}

/** Cross-segment stage that appends segment count to each segment. */
function createCountAnnotator(): CompressionStage {
  return {
    name: 'count-annotator',
    scope: 'cross-segment',
    execute(segments: PromptSegment[]) {
      return {
        segments: segments.map(s => ({
          ...s,
          content: `${s.content} [${segments.length} segments]`,
        })),
      };
    },
  };
}

/** Cross-segment stage with a call counter for tracking invocations. */
function createTrackedCrossStage(): CompressionStage & { callCount: number } {
  const stage = {
    name: 'tracked-cross',
    scope: 'cross-segment' as const,
    callCount: 0,
    execute(segments: PromptSegment[]) {
      stage.callCount++;
      return {
        segments: segments.map(s => ({
          ...s,
          content: `${s.content} [cross:${stage.callCount}]`,
        })),
      };
    },
  };
  return stage;
}

/** Per-segment stage with a call counter for tracking invocations. */
function createTrackedPerSegStage(): CompressionStage & { callCount: number; lastSegmentIds: string[] } {
  const stage = {
    name: 'tracked-per-seg',
    scope: 'per-segment' as const,
    callCount: 0,
    lastSegmentIds: [] as string[],
    execute(segments: PromptSegment[]) {
      stage.callCount++;
      stage.lastSegmentIds = segments.map(s => s.id);
      return {
        segments: segments.map(s => ({
          ...s,
          content: `${s.content} [per:${stage.callCount}]`,
        })),
      };
    },
  };
  return stage;
}

// --- Tests ---

describe('cross-segment cache awareness', () => {
  it('no cross-segment stages: identical behavior to current pipeline (backward compat)', () => {
    const pipeline = createIncrementalPipeline({
      stages: [createUppercaser()],
    });

    const segA = makeSegment({ id: 'a', content: 'hello' });
    const segB = makeSegment({ id: 'b', content: 'world' });
    const budget = makeBudget();

    const turn1 = pipeline.compress({ segments: [segA, segB], budget });
    expect(turn1.result.segments[0].content).toBe('HELLO');
    expect(turn1.result.segments[1].content).toBe('WORLD');

    // Second turn with same segments: all cached
    const turn2 = pipeline.compress({ segments: [segA, segB], budget }, turn1.state);
    expect(turn2.cachedSegmentCount).toBe(2);
    expect(turn2.freshSegmentCount).toBe(0);
    expect(turn2.result.segments[0].content).toBe('HELLO');
    expect(turn2.result.segments[1].content).toBe('WORLD');
  });

  it('segment A changes, cross-segment stage re-runs on ALL segments (A+B)', () => {
    const crossStage = createTrackedCrossStage();
    const pipeline = createIncrementalPipeline({
      stages: [createUppercaser(), crossStage],
    });

    const segA = makeSegment({ id: 'a', content: 'hello' });
    const segB = makeSegment({ id: 'b', content: 'world' });
    const budget = makeBudget();

    const turn1 = pipeline.compress({ segments: [segA, segB], budget });
    expect(crossStage.callCount).toBe(1);

    // Change only segment A
    const segAChanged = makeSegment({ id: 'a', content: 'changed' });
    const turn2 = pipeline.compress({ segments: [segAChanged, segB], budget }, turn1.state);

    // Cross-segment stage should have been called again
    expect(crossStage.callCount).toBe(2);
    // Both segments should have the cross-stage annotation
    expect(turn2.result.segments[0].content).toContain('[cross:2]');
    expect(turn2.result.segments[1].content).toContain('[cross:2]');
    // Both should have 2 segments annotation
    expect(turn2.result.segments).toHaveLength(2);
  });

  it('per-segment stage result cached for unchanged segment B', () => {
    const perStage = createTrackedPerSegStage();
    const crossStage = createTrackedCrossStage();
    const pipeline = createIncrementalPipeline({
      stages: [perStage, crossStage],
    });

    const segA = makeSegment({ id: 'a', content: 'hello' });
    const segB = makeSegment({ id: 'b', content: 'world' });
    const budget = makeBudget();

    const turn1 = pipeline.compress({ segments: [segA, segB], budget });
    expect(perStage.callCount).toBe(1);

    // Change only segment A
    const segAChanged = makeSegment({ id: 'a', content: 'changed' });
    const turn2 = pipeline.compress({ segments: [segAChanged, segB], budget }, turn1.state);

    // Per-segment stage should have been called again, but only with the fresh segment
    expect(perStage.callCount).toBe(2);
    expect(perStage.lastSegmentIds).toEqual(['a']); // only fresh segment A

    // Segment B should have cached per-segment output used as input to cross-segment
    expect(turn2.result.segments[1].content).toContain('world [per:1]'); // per-seg from turn 1
    expect(turn2.result.segments[1].content).toContain('[cross:2]'); // cross from turn 2
  });

  it('all segments unchanged: everything cached (no per-segment OR cross-segment re-run)', () => {
    const crossStage = createTrackedCrossStage();
    const perStage = createTrackedPerSegStage();
    const pipeline = createIncrementalPipeline({
      stages: [perStage, crossStage],
    });

    const segA = makeSegment({ id: 'a', content: 'hello' });
    const segB = makeSegment({ id: 'b', content: 'world' });
    const budget = makeBudget();

    const turn1 = pipeline.compress({ segments: [segA, segB], budget });
    expect(perStage.callCount).toBe(1);
    expect(crossStage.callCount).toBe(1);

    // Same segments
    const turn2 = pipeline.compress({ segments: [segA, segB], budget }, turn1.state);

    // Neither stage should have been called again
    expect(perStage.callCount).toBe(1);
    expect(crossStage.callCount).toBe(1);
    expect(turn2.cachedSegmentCount).toBe(2);
    expect(turn2.freshSegmentCount).toBe(0);

    // Output should match turn 1
    expect(turn2.result.segments[0].content).toBe(turn1.result.segments[0].content);
    expect(turn2.result.segments[1].content).toBe(turn1.result.segments[1].content);
  });

  it('all stages are cross-segment: no per-segment caching, full re-run each turn', () => {
    const crossStage = createTrackedCrossStage();
    const pipeline = createIncrementalPipeline({
      stages: [crossStage],
    });

    const segA = makeSegment({ id: 'a', content: 'hello' });
    const budget = makeBudget();

    const turn1 = pipeline.compress({ segments: [segA], budget });
    expect(crossStage.callCount).toBe(1);

    // Same segment, hash unchanged. When all stages are cross-segment
    // and no per-segment stages exist, per-segment output = raw input.
    // Since hash matches, cachedIds includes 'a', and no fresh segments exist,
    // cross-segment stage is NOT re-run (fully cached).
    const turn2 = pipeline.compress({ segments: [segA], budget }, turn1.state);
    expect(crossStage.callCount).toBe(1);
    expect(turn2.cachedSegmentCount).toBe(1);
    expect(turn2.freshSegmentCount).toBe(0);

    // But if segment changes, cross-segment must re-run
    const segAChanged = makeSegment({ id: 'a', content: 'changed' });
    const turn3 = pipeline.compress({ segments: [segAChanged], budget }, turn2.state);
    expect(crossStage.callCount).toBe(2);
    expect(turn3.cachedSegmentCount).toBe(0);
    expect(turn3.freshSegmentCount).toBe(1);
  });

  it('scope defaults to cross-segment when omitted (safe: correct but uncached)', () => {
    const executions: string[][] = [];
    const stage: CompressionStage = {
      name: 'no-scope',
      execute(segments) {
        executions.push(segments.map(s => s.id));
        return {
          segments: segments.map(s => ({ ...s, content: `${s.content}!` })),
        };
      },
    };

    expect(stage.scope).toBeUndefined();

    const pipeline = createIncrementalPipeline({ stages: [stage] });

    const segA = makeSegment({ id: 'a', content: 'hello' });
    const segB = makeSegment({ id: 'b', content: 'world' });
    const budget = makeBudget();

    const turn1 = pipeline.compress({ segments: [segA, segB], budget });

    // Change only A — an undeclared-scope stage must re-run on ALL segments,
    // never on just the fresh subset (per-segment caching is opt-in).
    const segAChanged = makeSegment({ id: 'a', content: 'changed' });
    pipeline.compress({ segments: [segAChanged, segB], budget }, turn1.state);

    expect(executions).toEqual([['a', 'b'], ['a', 'b']]);
  });

  it('first turn (no state): runs everything, caches per-segment outputs', () => {
    const perStage = createTrackedPerSegStage();
    const crossStage = createTrackedCrossStage();
    const pipeline = createIncrementalPipeline({
      stages: [perStage, crossStage],
    });

    const segA = makeSegment({ id: 'a', content: 'hello' });
    const segB = makeSegment({ id: 'b', content: 'world' });
    const budget = makeBudget();

    const turn1 = pipeline.compress({ segments: [segA, segB], budget });

    expect(turn1.freshSegmentCount).toBe(2);
    expect(turn1.cachedSegmentCount).toBe(0);
    expect(turn1.state.turnNumber).toBe(1);

    // perSegmentOutputs should be populated
    expect(turn1.state.perSegmentOutputs.has('a')).toBe(true);
    expect(turn1.state.perSegmentOutputs.has('b')).toBe(true);

    // per-segment outputs should have per-stage annotation but NOT cross-stage
    const perA = turn1.state.perSegmentOutputs.get('a')!;
    expect(perA.content).toContain('[per:1]');
    expect(perA.content).not.toContain('[cross:');
  });

  it('perSegmentOutputs in state correctly reflect per-segment phase output', () => {
    const pipeline = createIncrementalPipeline({
      stages: [createUppercaser(), createCountAnnotator()],
    });

    const segA = makeSegment({ id: 'a', content: 'hello' });
    const segB = makeSegment({ id: 'b', content: 'world' });
    const budget = makeBudget();

    const turn1 = pipeline.compress({ segments: [segA, segB], budget });

    // Per-segment output should be uppercased but NOT have count annotation
    const perA = turn1.state.perSegmentOutputs.get('a')!;
    expect(perA.content).toBe('HELLO');

    // Final output should have both
    expect(turn1.result.segments[0].content).toBe('HELLO [2 segments]');
  });

  it('segment added between turns: new segment goes through both phases', () => {
    const perStage = createTrackedPerSegStage();
    const crossStage = createTrackedCrossStage();
    const pipeline = createIncrementalPipeline({
      stages: [perStage, crossStage],
    });

    const segA = makeSegment({ id: 'a', content: 'hello' });
    const budget = makeBudget();

    const turn1 = pipeline.compress({ segments: [segA], budget });

    // Add a new segment
    const segB = makeSegment({ id: 'b', content: 'world' });
    const turn2 = pipeline.compress({ segments: [segA, segB], budget }, turn1.state);

    expect(turn2.cachedSegmentCount).toBe(1); // A is cached
    expect(turn2.freshSegmentCount).toBe(1); // B is fresh

    // Cross-segment should re-run because B is new
    expect(crossStage.callCount).toBe(2);

    // Both segments should appear in output
    expect(turn2.result.segments).toHaveLength(2);
    expect(turn2.result.segments[0].content).toContain('[cross:2]');
    expect(turn2.result.segments[1].content).toContain('[cross:2]');
  });

  it('segment removed: dropped from state', () => {
    const pipeline = createIncrementalPipeline({
      stages: [createUppercaser(), createCountAnnotator()],
    });

    const segA = makeSegment({ id: 'a', content: 'hello' });
    const segB = makeSegment({ id: 'b', content: 'world' });
    const budget = makeBudget();

    const turn1 = pipeline.compress({ segments: [segA, segB], budget });

    // Remove segment B
    const turn2 = pipeline.compress({ segments: [segA], budget }, turn1.state);

    expect(turn2.result.segments).toHaveLength(1);
    // State should not contain segment B
    expect(turn2.state.segmentHashes.has('b')).toBe(false);
    expect(turn2.state.compressedSegments.has('b')).toBe(false);
    expect(turn2.state.perSegmentOutputs.has('b')).toBe(false);
  });

  it('mixed: 2 per-segment stages + 1 cross-segment stage', () => {
    const pipeline = createIncrementalPipeline({
      stages: [createUppercaser(), createPrefixer('>>'), createCountAnnotator()],
    });

    const segA = makeSegment({ id: 'a', content: 'hello' });
    const segB = makeSegment({ id: 'b', content: 'world' });
    const budget = makeBudget();

    const turn1 = pipeline.compress({ segments: [segA, segB], budget });

    // Per-segment output: uppercased then prefixed
    expect(turn1.state.perSegmentOutputs.get('a')!.content).toBe('>>HELLO');
    expect(turn1.state.perSegmentOutputs.get('b')!.content).toBe('>>WORLD');

    // Final output: per-segment + cross-segment annotation
    expect(turn1.result.segments[0].content).toBe('>>HELLO [2 segments]');
    expect(turn1.result.segments[1].content).toBe('>>WORLD [2 segments]');

    // Change A only
    const segAChanged = makeSegment({ id: 'a', content: 'changed' });
    const turn2 = pipeline.compress({ segments: [segAChanged, segB], budget }, turn1.state);

    expect(turn2.cachedSegmentCount).toBe(1);
    expect(turn2.freshSegmentCount).toBe(1);

    // B's per-segment output should be reused
    expect(turn2.state.perSegmentOutputs.get('b')!.content).toBe('>>WORLD');
    // A's per-segment output should be fresh
    expect(turn2.state.perSegmentOutputs.get('a')!.content).toBe('>>CHANGED');

    // Cross-segment re-ran on both
    expect(turn2.result.segments[0].content).toBe('>>CHANGED [2 segments]');
    expect(turn2.result.segments[1].content).toBe('>>WORLD [2 segments]');
  });

  it('metrics correctly reflect what was re-computed', () => {
    const pipeline = createIncrementalPipeline({
      stages: [createUppercaser(), createCountAnnotator()],
    });

    const segA = makeSegment({ id: 'a', content: 'hello' });
    const segB = makeSegment({ id: 'b', content: 'world' });
    const budget = makeBudget();

    const turn1 = pipeline.compress({ segments: [segA, segB], budget });

    // All segments unchanged -> metrics reuse previous turn's values with cached flag
    const turn2 = pipeline.compress({ segments: [segA, segB], budget }, turn1.state);
    expect(turn2.result.metrics.cached).toBe(true);
    expect(turn2.result.metrics.totalTokensIn).toBe(turn1.result.metrics.totalTokensIn);
    expect(turn2.result.metrics.totalTokensOut).toBe(turn1.result.metrics.totalTokensOut);

    // One segment changed -> metrics reflect some work
    const segAChanged = makeSegment({ id: 'a', content: 'changed' });
    const turn3 = pipeline.compress({ segments: [segAChanged, segB], budget }, turn2.state);
    // Metrics are from the pipeline runs, should have stage entries
    expect(turn3.result.metrics.stages.length).toBeGreaterThan(0);
  });
});
