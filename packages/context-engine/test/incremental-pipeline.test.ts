/**
 * Tests for createIncrementalPipeline (pipeline/incremental-pipeline.ts):
 * hash-based caching of unchanged segments across turns, config
 * invalidation, and debug-mode source-map threading.
 */

import { describe, it, expect } from 'vitest';
import { createIncrementalPipeline } from '../src/pipeline/incremental-pipeline.js';
import type { PipelineState } from '../src/pipeline/incremental-pipeline.js';
import { createFormatStage } from '../src/format/serializer.js';
import { DefaultTokenCounter } from '../src/providers/defaults.js';
import type { BudgetConfig, CompressionStage, PromptSegment } from '../src/pipeline/types.js';
import { seg } from './helpers.js';

function makeBudget(overrides?: Partial<BudgetConfig>): BudgetConfig {
  return { maxTokens: 4096, outputReserve: 0, ...overrides };
}

function jsonContent(data: Record<string, unknown>[]): string {
  return JSON.stringify(data);
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

function createCrossSuffixer(): CompressionStage {
  return {
    name: 'suffixer',
    scope: 'cross-segment',
    execute(segments: PromptSegment[]) {
      return { segments: segments.map(s => ({ ...s, content: `${s.content}!` })) };
    },
  };
}

function createCrossDropper(idsToDrop: string[]): CompressionStage {
  return {
    name: 'cross-dropper',
    scope: 'cross-segment',
    execute(segments: PromptSegment[]) {
      return { segments: segments.filter(s => !idsToDrop.includes(s.id)) };
    },
  };
}

function createCrossAdder(addedId: string): CompressionStage {
  return {
    name: 'cross-adder',
    scope: 'cross-segment',
    execute(segments: PromptSegment[]) {
      return { segments: [...segments, seg(addedId, 'appended summary')] };
    },
  };
}

const sampleData = [
  { name: 'Alice', age: 30, city: 'NYC' },
  { name: 'Bob', age: 25, city: 'LA' },
  { name: 'Charlie', age: 35, city: 'SF' },
];

const sampleData2 = [
  { name: 'Diana', age: 28, city: 'Chicago' },
  { name: 'Eve', age: 22, city: 'Boston' },
];

describe('createIncrementalPipeline', () => {
  it('runs every segment fresh on the first turn', () => {
    const pipeline = createIncrementalPipeline({ stages: [createFormatStage()] });
    const segments = [seg('data', jsonContent(sampleData))];

    const { result, state, cachedSegmentCount, freshSegmentCount } = pipeline.compress({
      segments,
      budget: makeBudget(),
    });

    expect(result.segments).toHaveLength(1);
    expect(cachedSegmentCount).toBe(0);
    expect(freshSegmentCount).toBe(1);
    expect(state.turnNumber).toBe(1);
    expect(result.metrics.totalTokensIn).toBeGreaterThan(0);
  });

  it('reuses every segment from cache when nothing changes on the second turn', () => {
    const pipeline = createIncrementalPipeline({ stages: [createFormatStage()] });
    const segments = [seg('data', jsonContent(sampleData))];
    const budget = makeBudget();

    const turn1 = pipeline.compress({ segments, budget });
    const turn2 = pipeline.compress({ segments, budget }, turn1.state);

    expect(turn2.cachedSegmentCount).toBe(1);
    expect(turn2.freshSegmentCount).toBe(0);
    expect(turn2.result.segments[0].content).toBe(turn1.result.segments[0].content);
  });

  it('invalidates the cache when the budget changes between turns', () => {
    const pipeline = createIncrementalPipeline({ stages: [createFormatStage()] });
    const segments = [seg('data', jsonContent(sampleData))];

    const turn1 = pipeline.compress({ segments, budget: makeBudget({ maxTokens: 8000 }) });
    const turn2 = pipeline.compress({ segments, budget: makeBudget({ maxTokens: 200 }) }, turn1.state);

    expect(turn2.cachedSegmentCount).toBe(0);
    expect(turn2.freshSegmentCount).toBe(1);
  });

  it('invalidates the cache when the model changes between turns', () => {
    const pipeline = createIncrementalPipeline({ stages: [createFormatStage()] });
    const segments = [seg('data', jsonContent(sampleData))];
    const budget = makeBudget();

    const turn1 = pipeline.compress({ segments, budget, model: 'gpt-4o' });
    const turn2 = pipeline.compress({ segments, budget, model: 'claude-sonnet-4-6' }, turn1.state);

    expect(turn2.cachedSegmentCount).toBe(0);
    expect(turn2.freshSegmentCount).toBe(1);
  });

  it('invalidates the cache when the query changes between turns', () => {
    const pipeline = createIncrementalPipeline({ stages: [createUppercaser()] });
    const budget = makeBudget();
    const segments = [seg('a', 'hello')];

    const turn1 = pipeline.compress({ segments, budget, query: 'first question' });
    const turn2 = pipeline.compress({ segments, budget, query: 'different question' }, turn1.state);

    expect(turn2.cachedSegmentCount).toBe(0);
    expect(turn2.freshSegmentCount).toBe(1);
  });

  it('invalidates the cache when priority changes with identical content', () => {
    const pipeline = createIncrementalPipeline({ stages: [createUppercaser()] });
    const budget = makeBudget();

    const turn1 = pipeline.compress({ segments: [seg('a', 'hello', 'memory', { priority: 1 })], budget });
    const turn2 = pipeline.compress(
      { segments: [seg('a', 'hello', 'memory', { priority: 2 })], budget },
      turn1.state,
    );

    expect(turn2.cachedSegmentCount).toBe(0);
    expect(turn2.freshSegmentCount).toBe(1);
  });

  it('invalidates the cache and bypasses stages when locked flips with identical content', () => {
    const pipeline = createIncrementalPipeline({ stages: [createUppercaser()] });
    const budget = makeBudget();

    const turn1 = pipeline.compress({ segments: [seg('a', 'hello', 'memory', { locked: false })], budget });
    expect(turn1.result.segments[0].content).toBe('HELLO');

    const turn2 = pipeline.compress(
      { segments: [seg('a', 'hello', 'memory', { locked: true })], budget },
      turn1.state,
    );

    expect(turn2.cachedSegmentCount).toBe(0);
    expect(turn2.result.segments[0].content).toBe('hello');
  });

  it('warns at construction when a per-segment stage follows a cross-segment stage', () => {
    const warnings: string[] = [];

    createIncrementalPipeline({
      stages: [createCrossSuffixer(), createUppercaser()],
      logger: { warn: m => warnings.push(m) },
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('uppercaser');
    expect(warnings[0]).toContain('suffixer');
  });

  it('does not warn when per-segment stages precede cross-segment stages', () => {
    const warnings: string[] = [];

    createIncrementalPipeline({
      stages: [createUppercaser(), createCrossSuffixer()],
      logger: { warn: m => warnings.push(m) },
    });

    expect(warnings).toHaveLength(0);
  });

  it('threads full source-map attribution through a fresh debug turn', () => {
    const pipeline = createIncrementalPipeline({
      stages: [createUppercaser(), createCrossSuffixer()],
      debug: true,
    });

    const turn1 = pipeline.compress({ segments: [seg('a', 'hello')], budget: makeBudget() });

    expect(turn1.result.sourceMap).toHaveLength(1);
    expect(turn1.result.sourceMap![0]).toMatchObject({
      original: 'hello',
      compressed: 'HELLO!',
      changedBy: ['uppercaser', 'suffixer'],
    });
    expect(turn1.result.sourceMap![0].fromCache).toBeUndefined();
  });

  it('marks reused source-map provenance as fromCache on a fully cached debug turn', () => {
    const pipeline = createIncrementalPipeline({
      stages: [createUppercaser(), createCrossSuffixer()],
      debug: true,
    });
    const budget = makeBudget();
    const segments = [seg('a', 'hello')];

    const turn1 = pipeline.compress({ segments, budget });
    const turn2 = pipeline.compress({ segments, budget }, turn1.state);

    expect(turn2.cachedSegmentCount).toBe(1);
    expect(turn2.result.sourceMap![0]).toMatchObject({
      original: 'hello',
      compressed: 'HELLO!',
      changedBy: ['uppercaser', 'suffixer'],
      fromCache: true,
    });
  });

  it('rebuilds fresh source-map provenance when content changes on a debug turn', () => {
    const pipeline = createIncrementalPipeline({
      stages: [createUppercaser(), createCrossSuffixer()],
      debug: true,
    });
    const budget = makeBudget();

    const turn1 = pipeline.compress({ segments: [seg('a', 'hello')], budget });
    const turn2 = pipeline.compress({ segments: [seg('a', 'goodbye')], budget }, turn1.state);

    expect(turn2.result.sourceMap![0]).toMatchObject({ original: 'goodbye', compressed: 'GOODBYE!' });
    expect(turn2.result.sourceMap![0].fromCache).toBeUndefined();
  });

  it('synthesizes per-segment provenance for cached segments when prior state predates debug mode', () => {
    const pipeline = createIncrementalPipeline({ stages: [createUppercaser()], debug: true });
    const budget = makeBudget();
    const segments = [seg('a', 'hello')];

    const turn1 = pipeline.compress({ segments, budget });
    const legacyState: PipelineState = { ...turn1.state, perSegmentSourceMap: undefined };

    const turn2 = pipeline.compress({ segments, budget }, legacyState);

    expect(turn2.cachedSegmentCount).toBe(1);
    const entry = turn2.result.sourceMap!.find(e => e.segmentId === 'a')!;
    expect(entry.original).toBe('hello');
    expect(entry.compressed).toBe('HELLO');
    expect(entry.changedBy).toEqual([]);
    expect(entry.fromCache).toBe(true);
  });

  it('falls back to input-based change detection when prior state lacks per-segment output hashes', () => {
    const suffixer = createCrossSuffixer();
    let crossCalls = 0;
    const trackedSuffixer: CompressionStage = {
      name: suffixer.name,
      scope: 'cross-segment',
      execute(segments, context) {
        crossCalls++;
        return suffixer.execute(segments, context);
      },
    };
    const pipeline = createIncrementalPipeline({ stages: [createUppercaser(), trackedSuffixer] });
    const budget = makeBudget();

    const turn1 = pipeline.compress({ segments: [seg('a', 'hello'), seg('b', 'world')], budget });
    expect(crossCalls).toBe(1);

    const legacyState = { ...turn1.state, perSegmentOutputHashes: undefined } as unknown as PipelineState;
    const turn2 = pipeline.compress(
      { segments: [seg('a', 'changed'), seg('b', 'world')], budget },
      legacyState,
    );

    expect(crossCalls).toBe(2);
    expect(turn2.result.segments.map(s => s.content)).toEqual(['CHANGED!', 'WORLD!']);
  });

  it('does not resurrect segments removed by a cross-segment stage when fully cached', () => {
    const pipeline = createIncrementalPipeline({ stages: [createCrossDropper(['b'])], debug: true });
    const budget = makeBudget();
    const segments = [seg('a', 'keep'), seg('b', 'drop me')];

    const turn1 = pipeline.compress({ segments, budget });
    expect(turn1.result.segments.map(s => s.id)).toEqual(['a']);

    const turn2 = pipeline.compress({ segments, budget }, turn1.state);
    expect(turn2.result.segments.map(s => s.id)).toEqual(['a']);

    const b = turn2.result.sourceMap!.find(e => e.segmentId === 'b')!;
    expect(b).toMatchObject({ removed: true, removedBy: 'cross-dropper' });
  });

  it('re-compresses only the changed segment and keeps the cached one identical', () => {
    const pipeline = createIncrementalPipeline({ stages: [createFormatStage()] });
    const budget = makeBudget();
    const stable = seg('a', jsonContent(sampleData));

    const turn1 = pipeline.compress({ segments: [stable, seg('b', jsonContent(sampleData2))], budget });
    const turn2 = pipeline.compress(
      { segments: [stable, seg('b', jsonContent([{ x: 1 }]))], budget },
      turn1.state,
    );

    expect(turn2.cachedSegmentCount).toBe(1);
    expect(turn2.freshSegmentCount).toBe(1);
    expect(turn2.result.segments[0].content).toBe(turn1.result.segments[0].content);
  });

  it('compresses an added segment while reusing existing ones', () => {
    const pipeline = createIncrementalPipeline({ stages: [createFormatStage()] });
    const budget = makeBudget();
    const first = seg('a', jsonContent(sampleData));

    const turn1 = pipeline.compress({ segments: [first], budget });
    const turn2 = pipeline.compress({ segments: [first, seg('b', jsonContent(sampleData2))], budget }, turn1.state);

    expect(turn2.cachedSegmentCount).toBe(1);
    expect(turn2.freshSegmentCount).toBe(1);
    expect(turn2.result.segments).toHaveLength(2);
  });

  it('drops a removed segment from all state maps', () => {
    const pipeline = createIncrementalPipeline({ stages: [createFormatStage()] });
    const budget = makeBudget();
    const first = seg('a', jsonContent(sampleData));

    const turn1 = pipeline.compress({ segments: [first, seg('b', jsonContent(sampleData2))], budget });
    const turn2 = pipeline.compress({ segments: [first], budget }, turn1.state);

    expect(turn2.result.segments).toHaveLength(1);
    expect(turn2.state.segmentHashes.has('b')).toBe(false);
    expect(turn2.state.compressedSegments.has('b')).toBe(false);
  });

  it('increments the turn counter on every call', () => {
    const pipeline = createIncrementalPipeline({ stages: [createFormatStage()] });
    const segments = [seg('a', 'hello')];
    const budget = makeBudget();

    const turn1 = pipeline.compress({ segments, budget });
    const turn2 = pipeline.compress({ segments, budget }, turn1.state);
    const turn3 = pipeline.compress({ segments, budget }, turn2.state);

    expect([turn1.state.turnNumber, turn2.state.turnNumber, turn3.state.turnNumber]).toEqual([1, 2, 3]);
  });

  it('keeps a stable hash for unchanged content and a different hash for changed content', () => {
    const pipeline = createIncrementalPipeline({ stages: [createFormatStage()] });
    const budget = makeBudget();
    const first = seg('a', jsonContent(sampleData));

    const turn1 = pipeline.compress({ segments: [first], budget });
    const hash1 = turn1.state.segmentHashes.get('a');

    const turn2 = pipeline.compress({ segments: [first], budget }, turn1.state);
    const turn3 = pipeline.compress({ segments: [seg('a', jsonContent(sampleData2))], budget }, turn2.state);

    expect(typeof hash1).toBe('number');
    expect(turn2.state.segmentHashes.get('a')).toBe(hash1);
    expect(turn3.state.segmentHashes.get('a')).not.toBe(hash1);
  });

  it('stores the compressed output in state', () => {
    const pipeline = createIncrementalPipeline({ stages: [createUppercaser()] });

    const turn1 = pipeline.compress({ segments: [seg('a', 'hello world')], budget: makeBudget() });

    expect(turn1.state.compressedSegments.get('a')!.content).toBe('HELLO WORLD');
  });

  it('caches locked segments without compressing them', () => {
    const pipeline = createIncrementalPipeline({ stages: [createUppercaser()] });
    const budget = makeBudget();
    const locked = seg('sys', 'system prompt', 'system', { locked: true });

    const turn1 = pipeline.compress({ segments: [locked], budget });
    expect(turn1.result.segments[0].content).toBe('system prompt');

    const turn2 = pipeline.compress({ segments: [locked], budget }, turn1.state);
    expect(turn2.cachedSegmentCount).toBe(1);
    expect(turn2.freshSegmentCount).toBe(0);
    expect(turn2.result.segments[0].content).toBe('system prompt');
  });

  it('runs the full pipeline every turn when caching is disabled', () => {
    const pipeline = createIncrementalPipeline({ stages: [createUppercaser()], enableCaching: false });
    const budget = makeBudget();
    const segments = [seg('a', 'hello')];

    const turn1 = pipeline.compress({ segments, budget });
    const turn2 = pipeline.compress({ segments, budget }, turn1.state);

    expect(turn2.cachedSegmentCount).toBe(0);
    expect(turn2.freshSegmentCount).toBe(1);
    expect(turn2.state.turnNumber).toBe(2);
  });

  it('reuses last turn metrics with a cached flag when every segment is cached', () => {
    const pipeline = createIncrementalPipeline({ stages: [createFormatStage()] });
    const segments = [seg('data', jsonContent(sampleData))];
    const budget = makeBudget();

    const turn1 = pipeline.compress({ segments, budget });
    const turn2 = pipeline.compress({ segments, budget }, turn1.state);

    expect(turn2.result.metrics.totalTokensIn).toBe(turn1.result.metrics.totalTokensIn);
    expect(turn2.result.metrics.totalTokensOut).toBe(turn1.result.metrics.totalTokensOut);
    expect(turn2.result.metrics.cached).toBe(true);
  });

  it('reports full-prompt token totals on partially-cached turns', () => {
    const pipeline = createIncrementalPipeline({ stages: [createUppercaser(), createCrossSuffixer()] });
    const budget = makeBudget();
    const counter = new DefaultTokenCounter();
    const stable = seg('a', 'a long stable segment that never changes between turns');

    const turn1 = pipeline.compress({ segments: [stable, seg('b', 'short')], budget });

    const segments2 = [stable, seg('b', 'brief')];
    const turn2 = pipeline.compress({ segments: segments2, budget }, turn1.state);

    expect(turn2.cachedSegmentCount).toBe(1);
    const expectedIn = segments2.reduce((sum, s) => sum + counter.countTokens(s.content), 0);
    const expectedOut = turn2.result.segments.reduce((sum, s) => sum + counter.countTokens(s.content), 0);
    expect(turn2.result.metrics.totalTokensIn).toBe(expectedIn);
    expect(turn2.result.metrics.totalTokensOut).toBe(expectedOut);
  });

  it('reports fresh (uncached) metrics when a segment changes', () => {
    const pipeline = createIncrementalPipeline({ stages: [createFormatStage()] });
    const budget = makeBudget();

    const turn1 = pipeline.compress({ segments: [seg('a', jsonContent(sampleData))], budget });
    const turn2 = pipeline.compress({ segments: [seg('a', jsonContent(sampleData2))], budget }, turn1.state);

    expect(turn2.result.metrics.totalTokensIn).toBeGreaterThan(0);
    expect(turn2.result.metrics.cached).toBeUndefined();
  });

  it('preserves segment order across a mixed cached-and-fresh turn', () => {
    const pipeline = createIncrementalPipeline({ stages: [createUppercaser()] });
    const budget = makeBudget();
    const first = seg('a', 'first');
    const third = seg('c', 'third');

    const turn1 = pipeline.compress({ segments: [first, seg('b', 'second'), third], budget });
    const turn2 = pipeline.compress({ segments: [first, seg('b', 'changed'), third], budget }, turn1.state);

    expect(turn2.cachedSegmentCount).toBe(2);
    expect(turn2.freshSegmentCount).toBe(1);
    expect(turn2.result.segments.map(s => s.id)).toEqual(['a', 'b', 'c']);
    expect(turn2.result.segments.map(s => s.content)).toEqual(['FIRST', 'CHANGED', 'THIRD']);
  });

  it('handles an empty segment list', () => {
    const pipeline = createIncrementalPipeline({ stages: [createFormatStage()] });

    const result = pipeline.compress({ segments: [], budget: makeBudget() });

    expect(result.result.segments).toHaveLength(0);
    expect(result.cachedSegmentCount).toBe(0);
    expect(result.freshSegmentCount).toBe(0);
    expect(result.state.turnNumber).toBe(1);
  });

  it('counts cached and fresh segments across a batch of partial changes', () => {
    const pipeline = createIncrementalPipeline({ stages: [createUppercaser()] });
    const budget = makeBudget();
    const unchanged = [seg('a', 'one'), seg('c', 'three')];

    const turn1 = pipeline.compress({
      segments: [unchanged[0], seg('b', 'two'), unchanged[1], seg('d', 'four')],
      budget,
    });
    const turn2 = pipeline.compress(
      { segments: [unchanged[0], seg('b', 'two modified'), unchanged[1], seg('d', 'four modified')], budget },
      turn1.state,
    );

    expect(turn2.cachedSegmentCount).toBe(2);
    expect(turn2.freshSegmentCount).toBe(2);
  });

  it('runs every stage on fresh segments across turns', () => {
    const pipeline = createIncrementalPipeline({ stages: [createFormatStage(), createUppercaser()] });
    const budget = makeBudget();

    const turn1 = pipeline.compress({ segments: [seg('data', jsonContent(sampleData))], budget });
    const content1 = turn1.result.segments[0].content;
    expect(content1).toBe(content1.toUpperCase());
    expect(content1).not.toBe(jsonContent(sampleData).toUpperCase());

    const turn2 = pipeline.compress({ segments: [seg('data', jsonContent(sampleData2))], budget }, turn1.state);
    const content2 = turn2.result.segments[0].content;
    expect(turn2.freshSegmentCount).toBe(1);
    expect(content2).toBe(content2.toUpperCase());
    expect(content2).not.toBe(content1);
  });

  it('keeps every state map sized to the current segment set across additions and removals', () => {
    const pipeline = createIncrementalPipeline({ stages: [createUppercaser()] });
    const budget = makeBudget();
    const a = seg('a', 'alpha');
    const b = seg('b', 'beta');
    const c = seg('c', 'gamma');
    const d = seg('d', 'delta');

    const turn1 = pipeline.compress({ segments: [a, b, c], budget });
    expect(turn1.state.segmentHashes.size).toBe(3);
    expect(turn1.state.compressedSegments.size).toBe(3);
    expect(turn1.state.perSegmentOutputs.size).toBe(3);

    const turn2 = pipeline.compress({ segments: [a, b, c, d], budget }, turn1.state);
    expect(turn2.state.segmentHashes.size).toBe(4);
    expect(turn2.state.compressedSegments.size).toBe(4);
    expect(turn2.state.perSegmentOutputs.size).toBe(4);

    const turn3 = pipeline.compress({ segments: [a, d], budget }, turn2.state);
    expect(turn3.state.segmentHashes.size).toBe(2);
    expect(turn3.state.compressedSegments.size).toBe(2);
    expect(turn3.state.perSegmentOutputs.size).toBe(2);
    for (const removed of ['b', 'c']) {
      expect(turn3.state.segmentHashes.has(removed)).toBe(false);
      expect(turn3.state.compressedSegments.has(removed)).toBe(false);
      expect(turn3.state.perSegmentOutputs.has(removed)).toBe(false);
    }
  });

  it('resumes from a state rebuilt out of its own serializable maps', () => {
    const pipeline = createIncrementalPipeline({ stages: [createUppercaser()] });
    const budget = makeBudget();
    const segment = seg('a', 'test data');

    const turn1 = pipeline.compress({ segments: [segment], budget });
    const restored: PipelineState = {
      segmentHashes: new Map(turn1.state.segmentHashes),
      compressedSegments: new Map(turn1.state.compressedSegments),
      perSegmentOutputs: new Map(turn1.state.perSegmentOutputs),
      perSegmentOutputHashes: new Map(turn1.state.perSegmentOutputHashes),
      lastMetrics: { ...turn1.state.lastMetrics },
      turnNumber: turn1.state.turnNumber,
      configFingerprint: turn1.state.configFingerprint,
    };

    const turn2 = pipeline.compress({ segments: [segment], budget }, restored);

    expect(turn2.cachedSegmentCount).toBe(1);
    expect(turn2.freshSegmentCount).toBe(0);
    expect(turn2.result.segments[0].content).toBe('TEST DATA');
  });

  it('invalidates the cache when metadata changes on a segment with default priority and locked', () => {
    const pipeline = createIncrementalPipeline({ stages: [createUppercaser()] });
    const budget = makeBudget();
    const withMeta = (source: string): PromptSegment => ({
      id: 'a',
      content: 'hello',
      role: 'memory',
      metadata: { source },
    });

    const turn1 = pipeline.compress({ segments: [withMeta('v1')], budget });
    const turn2 = pipeline.compress({ segments: [withMeta('v2')], budget }, turn1.state);

    expect(turn2.cachedSegmentCount).toBe(0);
    expect(turn2.freshSegmentCount).toBe(1);
  });

  it('reports placeholder metrics on the first turn when configured with no stages', () => {
    const pipeline = createIncrementalPipeline({ stages: [] });

    const turn1 = pipeline.compress({ segments: [seg('a', 'hello')], budget: makeBudget() });

    expect(turn1.result.metrics.stages).toEqual([
      expect.objectContaining({ name: '(none)' }),
    ]);
  });

  it('reports placeholder metrics on a changed turn when configured with no stages', () => {
    const pipeline = createIncrementalPipeline({ stages: [] });
    const budget = makeBudget();

    const turn1 = pipeline.compress({ segments: [seg('a', 'hello')], budget });
    const turn2 = pipeline.compress({ segments: [seg('a', 'goodbye')], budget }, turn1.state);

    expect(turn2.freshSegmentCount).toBe(1);
    expect(turn2.result.metrics.stages).toEqual([
      expect.objectContaining({ name: '(none)' }),
    ]);
  });

  it('reports a passthrough ratio when a changed segment compresses to empty content', () => {
    const pipeline = createIncrementalPipeline({ stages: [createUppercaser()] });
    const budget = makeBudget();

    const turn1 = pipeline.compress({ segments: [seg('a', 'hello')], budget });
    const turn2 = pipeline.compress({ segments: [seg('a', '')], budget }, turn1.state);

    expect(turn2.result.metrics.totalTokensIn).toBe(0);
    expect(turn2.result.metrics.overallRatio).toBe(1.0);
    expect(turn2.result.metrics.reductionPercent).toBe(0);
  });

  it('builds identity provenance for a cross-segment-only pipeline on a fresh debug turn', () => {
    const pipeline = createIncrementalPipeline({ stages: [createCrossSuffixer()], debug: true });

    const turn1 = pipeline.compress({ segments: [seg('a', 'hello')], budget: makeBudget() });

    const entry = turn1.result.sourceMap!.find(e => e.segmentId === 'a')!;
    expect(entry.original).toBe('hello');
    expect(entry.compressed).toBe('hello!');
    expect(entry.changedBy).toEqual(['suffixer']);
  });

  it('builds identity provenance for a fresh segment in a cross-only debug pipeline across turns', () => {
    const pipeline = createIncrementalPipeline({ stages: [createCrossSuffixer()], debug: true });
    const budget = makeBudget();

    const turn1 = pipeline.compress({ segments: [seg('a', 'hello')], budget });
    const turn2 = pipeline.compress({ segments: [seg('a', 'goodbye')], budget }, turn1.state);

    const entry = turn2.result.sourceMap!.find(e => e.segmentId === 'a')!;
    expect(entry.original).toBe('goodbye');
    expect(entry.compressed).toBe('goodbye!');
  });

  it('attributes a segment introduced by a cross-segment stage to that stage in debug mode', () => {
    const pipeline = createIncrementalPipeline({ stages: [createCrossAdder('summary')], debug: true });

    const turn1 = pipeline.compress({ segments: [seg('a', 'hello')], budget: makeBudget() });

    const added = turn1.result.sourceMap!.find(e => e.segmentId === 'summary')!;
    expect(added.addedBy).toBe('cross-adder');
    expect(added.compressed).toBe('appended summary');
  });

  it('omits locked segments from the composed debug source map', () => {
    const pipeline = createIncrementalPipeline({ stages: [createUppercaser()], debug: true });
    const segments = [seg('sys', 'system prompt', 'system', { locked: true }), seg('mem', 'data')];

    const turn1 = pipeline.compress({ segments, budget: makeBudget() });

    expect(turn1.result.sourceMap!.map(e => e.segmentId)).toEqual(['mem']);
  });

  it('skips locked segments when building identity provenance for a cross-only debug pipeline', () => {
    const pipeline = createIncrementalPipeline({ stages: [createCrossSuffixer()], debug: true });
    const segments = [seg('sys', 'system prompt', 'system', { locked: true }), seg('mem', 'data')];

    const turn1 = pipeline.compress({ segments, budget: makeBudget() });

    expect(turn1.result.sourceMap!.map(e => e.segmentId)).toEqual(['mem']);
  });

  it('reuses cross-phase output when debug is enabled on top of non-debug legacy state', () => {
    const stages = [createCrossSuffixer()];
    const plain = createIncrementalPipeline({ stages });
    const debugPipeline = createIncrementalPipeline({ stages, debug: true });
    const budget = makeBudget();
    const segments = [seg('a', 'hello')];

    const turn1 = plain.compress({ segments, budget });
    expect(turn1.state.crossSourceMap).toBeUndefined();

    const turn2 = debugPipeline.compress({ segments, budget }, turn1.state);

    expect(turn2.cachedSegmentCount).toBe(1);
    expect(turn2.result.segments[0].content).toBe('hello!');
    expect(turn2.result.sourceMap!.map(e => e.segmentId)).toEqual(['a']);
  });

  it('prunes cross-phase provenance for a removed segment on a fully cached debug turn', () => {
    const pipeline = createIncrementalPipeline({ stages: [createCrossSuffixer()], debug: true });
    const budget = makeBudget();
    const stable = seg('a', 'hello');

    const turn1 = pipeline.compress({ segments: [stable, seg('b', 'world')], budget });
    const turn2 = pipeline.compress({ segments: [stable], budget }, turn1.state);

    expect(turn2.result.segments.map(s => s.id)).toEqual(['a']);
    expect(turn2.state.crossSourceMap?.has('b')).toBe(false);
  });

  it('falls back to input-based detection and skips the cross phase when a legacy state is fully cached', () => {
    const suffixer = createCrossSuffixer();
    let crossCalls = 0;
    const trackedSuffixer: CompressionStage = {
      name: suffixer.name,
      scope: 'cross-segment',
      execute(segments, context) {
        crossCalls++;
        return suffixer.execute(segments, context);
      },
    };
    const pipeline = createIncrementalPipeline({ stages: [createUppercaser(), trackedSuffixer] });
    const budget = makeBudget();
    const segments = [seg('a', 'hello')];

    const turn1 = pipeline.compress({ segments, budget });
    expect(crossCalls).toBe(1);

    const legacyState = { ...turn1.state, perSegmentOutputHashes: undefined } as unknown as PipelineState;
    const turn2 = pipeline.compress({ segments, budget }, legacyState);

    expect(crossCalls).toBe(1);
    expect(turn2.result.segments[0].content).toBe(turn1.result.segments[0].content);
  });
});
