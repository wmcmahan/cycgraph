/**
 * Tests for createIncrementalPipeline (pipeline/incremental-pipeline.ts)
 * focused on cross-segment cache awareness: per-segment stages cache
 * individually while cross-segment stages re-run on all segments whenever
 * any per-segment output changes.
 */

import { describe, it, expect } from 'vitest';
import { createIncrementalPipeline } from '../src/pipeline/incremental-pipeline.js';
import type { BudgetConfig, CompressionStage, PromptSegment } from '../src/pipeline/types.js';
import { seg } from './helpers.js';

function makeBudget(overrides?: Partial<BudgetConfig>): BudgetConfig {
  return { maxTokens: 4096, outputReserve: 0, ...overrides };
}

function createUppercaser(): CompressionStage {
  return {
    name: 'uppercaser',
    scope: 'per-segment',
    execute(segments: PromptSegment[]) {
      return { segments: segments.map(s => ({ ...s, content: s.content.toUpperCase() })) };
    },
  };
}

function createPrefixer(prefix: string): CompressionStage {
  return {
    name: 'prefixer',
    scope: 'per-segment',
    execute(segments: PromptSegment[]) {
      return { segments: segments.map(s => ({ ...s, content: `${prefix}${s.content}` })) };
    },
  };
}

function createCountAnnotator(): CompressionStage {
  return {
    name: 'count-annotator',
    scope: 'cross-segment',
    execute(segments: PromptSegment[]) {
      return {
        segments: segments.map(s => ({ ...s, content: `${s.content} [${segments.length} segments]` })),
      };
    },
  };
}

function createTrackedCrossStage(): CompressionStage & { callCount: number } {
  const stage = {
    name: 'tracked-cross',
    scope: 'cross-segment' as const,
    callCount: 0,
    execute(segments: PromptSegment[]) {
      stage.callCount++;
      return { segments: segments.map(s => ({ ...s, content: `${s.content} [cross:${stage.callCount}]` })) };
    },
  };
  return stage;
}

function createTrackedPerSegStage(): CompressionStage & { callCount: number; lastSegmentIds: string[] } {
  const stage = {
    name: 'tracked-per-seg',
    scope: 'per-segment' as const,
    callCount: 0,
    lastSegmentIds: [] as string[],
    execute(segments: PromptSegment[]) {
      stage.callCount++;
      stage.lastSegmentIds = segments.map(s => s.id);
      return { segments: segments.map(s => ({ ...s, content: `${s.content} [per:${stage.callCount}]` })) };
    },
  };
  return stage;
}

describe('createIncrementalPipeline', () => {
  it('caches per-segment-only pipelines identically to a plain incremental run', () => {
    const pipeline = createIncrementalPipeline({ stages: [createUppercaser()] });
    const budget = makeBudget();
    const segA = seg('a', 'hello');
    const segB = seg('b', 'world');

    const turn1 = pipeline.compress({ segments: [segA, segB], budget });
    expect(turn1.result.segments.map(s => s.content)).toEqual(['HELLO', 'WORLD']);

    const turn2 = pipeline.compress({ segments: [segA, segB], budget }, turn1.state);
    expect(turn2.cachedSegmentCount).toBe(2);
    expect(turn2.freshSegmentCount).toBe(0);
    expect(turn2.result.segments.map(s => s.content)).toEqual(['HELLO', 'WORLD']);
  });

  it('re-runs a cross-segment stage on all segments when one segment changes', () => {
    const crossStage = createTrackedCrossStage();
    const pipeline = createIncrementalPipeline({ stages: [createUppercaser(), crossStage] });
    const budget = makeBudget();
    const segB = seg('b', 'world');

    const turn1 = pipeline.compress({ segments: [seg('a', 'hello'), segB], budget });
    expect(crossStage.callCount).toBe(1);

    const turn2 = pipeline.compress({ segments: [seg('a', 'changed'), segB], budget }, turn1.state);

    expect(crossStage.callCount).toBe(2);
    expect(turn2.result.segments).toHaveLength(2);
    expect(turn2.result.segments[0].content).toContain('[cross:2]');
    expect(turn2.result.segments[1].content).toContain('[cross:2]');
  });

  it('feeds a cached per-segment output into the re-run cross-segment stage', () => {
    const perStage = createTrackedPerSegStage();
    const crossStage = createTrackedCrossStage();
    const pipeline = createIncrementalPipeline({ stages: [perStage, crossStage] });
    const budget = makeBudget();
    const segB = seg('b', 'world');

    const turn1 = pipeline.compress({ segments: [seg('a', 'hello'), segB], budget });
    expect(perStage.callCount).toBe(1);

    const turn2 = pipeline.compress({ segments: [seg('a', 'changed'), segB], budget }, turn1.state);

    expect(perStage.callCount).toBe(2);
    expect(perStage.lastSegmentIds).toEqual(['a']);
    expect(turn2.result.segments[1].content).toContain('world [per:1]');
    expect(turn2.result.segments[1].content).toContain('[cross:2]');
  });

  it('re-runs neither phase when every segment is unchanged', () => {
    const crossStage = createTrackedCrossStage();
    const perStage = createTrackedPerSegStage();
    const pipeline = createIncrementalPipeline({ stages: [perStage, crossStage] });
    const budget = makeBudget();
    const segA = seg('a', 'hello');
    const segB = seg('b', 'world');

    const turn1 = pipeline.compress({ segments: [segA, segB], budget });
    const turn2 = pipeline.compress({ segments: [segA, segB], budget }, turn1.state);

    expect(perStage.callCount).toBe(1);
    expect(crossStage.callCount).toBe(1);
    expect(turn2.cachedSegmentCount).toBe(2);
    expect(turn2.freshSegmentCount).toBe(0);
    expect(turn2.result.segments.map(s => s.content)).toEqual(turn1.result.segments.map(s => s.content));
  });

  it('skips a cross-only pipeline when its single segment is unchanged and re-runs it when changed', () => {
    const crossStage = createTrackedCrossStage();
    const pipeline = createIncrementalPipeline({ stages: [crossStage] });
    const budget = makeBudget();
    const segA = seg('a', 'hello');

    const turn1 = pipeline.compress({ segments: [segA], budget });
    expect(crossStage.callCount).toBe(1);

    const turn2 = pipeline.compress({ segments: [segA], budget }, turn1.state);
    expect(crossStage.callCount).toBe(1);
    expect(turn2.cachedSegmentCount).toBe(1);
    expect(turn2.freshSegmentCount).toBe(0);

    const turn3 = pipeline.compress({ segments: [seg('a', 'changed')], budget }, turn2.state);
    expect(crossStage.callCount).toBe(2);
    expect(turn3.cachedSegmentCount).toBe(0);
    expect(turn3.freshSegmentCount).toBe(1);
  });

  it('treats an undeclared scope as cross-segment and re-runs it on all segments', () => {
    const executions: string[][] = [];
    const stage: CompressionStage = {
      name: 'no-scope',
      execute(segments) {
        executions.push(segments.map(s => s.id));
        return { segments: segments.map(s => ({ ...s, content: `${s.content}!` })) };
      },
    };
    expect(stage.scope).toBeUndefined();

    const pipeline = createIncrementalPipeline({ stages: [stage] });
    const budget = makeBudget();
    const segB = seg('b', 'world');

    const turn1 = pipeline.compress({ segments: [seg('a', 'hello'), segB], budget });
    pipeline.compress({ segments: [seg('a', 'changed'), segB], budget }, turn1.state);

    expect(executions).toEqual([['a', 'b'], ['a', 'b']]);
    expect(turn1.result.segments.map(s => s.content)).toEqual(['hello!', 'world!']);
  });

  it('caches per-segment outputs on the first turn before the cross phase runs', () => {
    const perStage = createTrackedPerSegStage();
    const crossStage = createTrackedCrossStage();
    const pipeline = createIncrementalPipeline({ stages: [perStage, crossStage] });

    const turn1 = pipeline.compress({ segments: [seg('a', 'hello'), seg('b', 'world')], budget: makeBudget() });

    expect(turn1.freshSegmentCount).toBe(2);
    expect(turn1.cachedSegmentCount).toBe(0);
    expect(turn1.state.turnNumber).toBe(1);
    const perA = turn1.state.perSegmentOutputs.get('a')!;
    expect(perA.content).toContain('[per:1]');
    expect(perA.content).not.toContain('[cross:');
  });

  it('stores per-segment phase output in state without the cross-segment annotation', () => {
    const pipeline = createIncrementalPipeline({ stages: [createUppercaser(), createCountAnnotator()] });

    const turn1 = pipeline.compress({ segments: [seg('a', 'hello'), seg('b', 'world')], budget: makeBudget() });

    expect(turn1.state.perSegmentOutputs.get('a')!.content).toBe('HELLO');
    expect(turn1.result.segments[0].content).toBe('HELLO [2 segments]');
  });

  it('runs an added segment through both phases while reusing the cached one', () => {
    const perStage = createTrackedPerSegStage();
    const crossStage = createTrackedCrossStage();
    const pipeline = createIncrementalPipeline({ stages: [perStage, crossStage] });
    const budget = makeBudget();
    const segA = seg('a', 'hello');

    const turn1 = pipeline.compress({ segments: [segA], budget });
    const turn2 = pipeline.compress({ segments: [segA, seg('b', 'world')], budget }, turn1.state);

    expect(turn2.cachedSegmentCount).toBe(1);
    expect(turn2.freshSegmentCount).toBe(1);
    expect(crossStage.callCount).toBe(2);
    expect(turn2.result.segments).toHaveLength(2);
    expect(turn2.result.segments[0].content).toContain('[cross:2]');
    expect(turn2.result.segments[1].content).toContain('[cross:2]');
  });

  it('drops a removed segment from every state map', () => {
    const pipeline = createIncrementalPipeline({ stages: [createUppercaser(), createCountAnnotator()] });
    const budget = makeBudget();
    const segA = seg('a', 'hello');

    const turn1 = pipeline.compress({ segments: [segA, seg('b', 'world')], budget });
    const turn2 = pipeline.compress({ segments: [segA], budget }, turn1.state);

    expect(turn2.result.segments).toHaveLength(1);
    expect(turn2.state.segmentHashes.has('b')).toBe(false);
    expect(turn2.state.compressedSegments.has('b')).toBe(false);
    expect(turn2.state.perSegmentOutputs.has('b')).toBe(false);
  });

  it('chains two per-segment stages before a cross-segment stage and caches the unchanged one', () => {
    const pipeline = createIncrementalPipeline({
      stages: [createUppercaser(), createPrefixer('>>'), createCountAnnotator()],
    });
    const budget = makeBudget();
    const segB = seg('b', 'world');

    const turn1 = pipeline.compress({ segments: [seg('a', 'hello'), segB], budget });
    expect(turn1.state.perSegmentOutputs.get('a')!.content).toBe('>>HELLO');
    expect(turn1.state.perSegmentOutputs.get('b')!.content).toBe('>>WORLD');
    expect(turn1.result.segments.map(s => s.content)).toEqual(['>>HELLO [2 segments]', '>>WORLD [2 segments]']);

    const turn2 = pipeline.compress({ segments: [seg('a', 'changed'), segB], budget }, turn1.state);

    expect(turn2.cachedSegmentCount).toBe(1);
    expect(turn2.freshSegmentCount).toBe(1);
    expect(turn2.state.perSegmentOutputs.get('b')!.content).toBe('>>WORLD');
    expect(turn2.state.perSegmentOutputs.get('a')!.content).toBe('>>CHANGED');
    expect(turn2.result.segments.map(s => s.content)).toEqual(['>>CHANGED [2 segments]', '>>WORLD [2 segments]']);
  });

  it('reports cached metrics when unchanged and real stage metrics when a segment changes', () => {
    const pipeline = createIncrementalPipeline({ stages: [createUppercaser(), createCountAnnotator()] });
    const budget = makeBudget();
    const segA = seg('a', 'hello');
    const segB = seg('b', 'world');

    const turn1 = pipeline.compress({ segments: [segA, segB], budget });

    const turn2 = pipeline.compress({ segments: [segA, segB], budget }, turn1.state);
    expect(turn2.result.metrics.cached).toBe(true);
    expect(turn2.result.metrics.totalTokensIn).toBe(turn1.result.metrics.totalTokensIn);
    expect(turn2.result.metrics.totalTokensOut).toBe(turn1.result.metrics.totalTokensOut);

    const turn3 = pipeline.compress({ segments: [seg('a', 'changed'), segB], budget }, turn2.state);
    expect(turn3.result.metrics.stages.length).toBeGreaterThan(0);
  });
});
