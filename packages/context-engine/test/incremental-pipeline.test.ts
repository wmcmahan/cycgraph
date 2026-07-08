import { describe, it, expect } from 'vitest';
import { createIncrementalPipeline } from '../src/pipeline/incremental-pipeline.js';
import type { PipelineState, IncrementalResult } from '../src/pipeline/incremental-pipeline.js';
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

/** JSON content that the format stage can actually compress. */
function jsonContent(data: Record<string, unknown>[]): string {
  return JSON.stringify(data);
}

/** Simple stage that uppercases content (for verifying stage execution). */
function createUppercaser(): CompressionStage {
  return {
    name: 'uppercaser',
    execute(segments: PromptSegment[]) {
      return {
        segments: segments.map(s => ({ ...s, content: s.content.toUpperCase() })),
      };
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

// --- Tests ---

describe('createIncrementalPipeline', () => {
  it('first turn (no state) produces same result as batch pipeline', () => {
    const pipeline = createIncrementalPipeline({
      stages: [createFormatStage()],
    });

    const segments = [
      makeSegment({ id: 'data', content: jsonContent(sampleData) }),
    ];
    const budget = makeBudget();

    const { result, state, cachedSegmentCount, freshSegmentCount } = pipeline.compress(
      { segments, budget },
    );

    expect(result.segments).toHaveLength(1);
    expect(cachedSegmentCount).toBe(0);
    expect(freshSegmentCount).toBe(1);
    expect(state.turnNumber).toBe(1);
    expect(result.metrics.totalTokensIn).toBeGreaterThan(0);
  });

  it('second turn with identical segments reuses all from cache', () => {
    const pipeline = createIncrementalPipeline({
      stages: [createFormatStage()],
    });

    const segments = [
      makeSegment({ id: 'data', content: jsonContent(sampleData) }),
    ];
    const budget = makeBudget();

    const turn1 = pipeline.compress({ segments, budget });
    const turn2 = pipeline.compress({ segments, budget }, turn1.state);

    expect(turn2.cachedSegmentCount).toBe(1);
    expect(turn2.freshSegmentCount).toBe(0);
    expect(turn2.result.segments[0].content).toBe(turn1.result.segments[0].content);
  });

  it('invalidates the cache when the budget changes between turns', () => {
    const pipeline = createIncrementalPipeline({ stages: [createFormatStage()] });
    const segments = [makeSegment({ id: 'data', content: jsonContent(sampleData) })];

    const turn1 = pipeline.compress({ segments, budget: makeBudget({ maxTokens: 8000 }) });
    // Same content, but a much tighter budget. Reusing the cached (larger)
    // output would blow the new budget — the cache must be invalidated.
    const turn2 = pipeline.compress(
      { segments, budget: makeBudget({ maxTokens: 200 }) },
      turn1.state,
    );

    expect(turn2.cachedSegmentCount).toBe(0);
    expect(turn2.freshSegmentCount).toBe(1);
  });

  it('invalidates the cache when the model changes between turns', () => {
    const pipeline = createIncrementalPipeline({ stages: [createFormatStage()] });
    const segments = [makeSegment({ id: 'data', content: jsonContent(sampleData) })];
    const budget = makeBudget();

    const turn1 = pipeline.compress({ segments, budget, model: 'gpt-4o' });
    const turn2 = pipeline.compress({ segments, budget, model: 'claude-sonnet-4-6' }, turn1.state);

    expect(turn2.cachedSegmentCount).toBe(0);
    expect(turn2.freshSegmentCount).toBe(1);
  });

  it('second turn with one changed segment only re-compresses that one', () => {
    const pipeline = createIncrementalPipeline({
      stages: [createFormatStage()],
    });

    const seg1 = makeSegment({ id: 'a', content: jsonContent(sampleData) });
    const seg2 = makeSegment({ id: 'b', content: jsonContent(sampleData2) });
    const budget = makeBudget();

    const turn1 = pipeline.compress({ segments: [seg1, seg2], budget });

    // Change segment b only
    const seg2Changed = makeSegment({ id: 'b', content: jsonContent([{ x: 1 }]) });
    const turn2 = pipeline.compress({ segments: [seg1, seg2Changed], budget }, turn1.state);

    expect(turn2.cachedSegmentCount).toBe(1);
    expect(turn2.freshSegmentCount).toBe(1);
    // Segment a should be identical to turn 1
    expect(turn2.result.segments[0].content).toBe(turn1.result.segments[0].content);
  });

  it('segment addition: new segment goes through pipeline, existing cached', () => {
    const pipeline = createIncrementalPipeline({
      stages: [createFormatStage()],
    });

    const seg1 = makeSegment({ id: 'a', content: jsonContent(sampleData) });
    const budget = makeBudget();

    const turn1 = pipeline.compress({ segments: [seg1], budget });

    const seg2 = makeSegment({ id: 'b', content: jsonContent(sampleData2) });
    const turn2 = pipeline.compress({ segments: [seg1, seg2], budget }, turn1.state);

    expect(turn2.cachedSegmentCount).toBe(1);
    expect(turn2.freshSegmentCount).toBe(1);
    expect(turn2.result.segments).toHaveLength(2);
  });

  it('segment removal: removed segment dropped from state', () => {
    const pipeline = createIncrementalPipeline({
      stages: [createFormatStage()],
    });

    const seg1 = makeSegment({ id: 'a', content: jsonContent(sampleData) });
    const seg2 = makeSegment({ id: 'b', content: jsonContent(sampleData2) });
    const budget = makeBudget();

    const turn1 = pipeline.compress({ segments: [seg1, seg2], budget });

    // Remove segment b
    const turn2 = pipeline.compress({ segments: [seg1], budget }, turn1.state);

    expect(turn2.result.segments).toHaveLength(1);
    expect(turn2.state.segmentHashes.has('b')).toBe(false);
    expect(turn2.state.compressedSegments.has('b')).toBe(false);
  });

  it('turn counter increments', () => {
    const pipeline = createIncrementalPipeline({
      stages: [createFormatStage()],
    });

    const segments = [makeSegment({ id: 'a', content: 'hello' })];
    const budget = makeBudget();

    const turn1 = pipeline.compress({ segments, budget });
    expect(turn1.state.turnNumber).toBe(1);

    const turn2 = pipeline.compress({ segments, budget }, turn1.state);
    expect(turn2.state.turnNumber).toBe(2);

    const turn3 = pipeline.compress({ segments, budget }, turn2.state);
    expect(turn3.state.turnNumber).toBe(3);
  });

  it('state contains correct hashes after each turn', () => {
    const pipeline = createIncrementalPipeline({
      stages: [createFormatStage()],
    });

    const seg1 = makeSegment({ id: 'a', content: jsonContent(sampleData) });
    const budget = makeBudget();

    const turn1 = pipeline.compress({ segments: [seg1], budget });
    const hash1 = turn1.state.segmentHashes.get('a');
    expect(hash1).toBeDefined();
    expect(typeof hash1).toBe('number');

    // Same content -> same hash
    const turn2 = pipeline.compress({ segments: [seg1], budget }, turn1.state);
    expect(turn2.state.segmentHashes.get('a')).toBe(hash1);

    // Different content -> different hash
    const seg1Changed = makeSegment({ id: 'a', content: jsonContent(sampleData2) });
    const turn3 = pipeline.compress({ segments: [seg1Changed], budget }, turn2.state);
    expect(turn3.state.segmentHashes.get('a')).not.toBe(hash1);
  });

  it('state contains correct compressed segments', () => {
    const pipeline = createIncrementalPipeline({
      stages: [createUppercaser()],
    });

    const seg = makeSegment({ id: 'a', content: 'hello world' });
    const budget = makeBudget();

    const turn1 = pipeline.compress({ segments: [seg], budget });

    const compressed = turn1.state.compressedSegments.get('a');
    expect(compressed).toBeDefined();
    expect(compressed!.content).toBe('HELLO WORLD');
  });

  it('locked segments are cached correctly', () => {
    const pipeline = createIncrementalPipeline({
      stages: [createUppercaser()],
    });

    const seg = makeSegment({ id: 'sys', content: 'system prompt', locked: true });
    const budget = makeBudget();

    const turn1 = pipeline.compress({ segments: [seg], budget });
    // Locked segments bypass compression
    expect(turn1.result.segments[0].content).toBe('system prompt');

    const turn2 = pipeline.compress({ segments: [seg], budget }, turn1.state);
    // Should be cached (content unchanged)
    expect(turn2.cachedSegmentCount).toBe(1);
    expect(turn2.freshSegmentCount).toBe(0);
    expect(turn2.result.segments[0].content).toBe('system prompt');
  });

  it('enableCaching=false: always runs full pipeline', () => {
    const pipeline = createIncrementalPipeline({
      stages: [createUppercaser()],
      enableCaching: false,
    });

    const seg = makeSegment({ id: 'a', content: 'hello' });
    const budget = makeBudget();

    const turn1 = pipeline.compress({ segments: [seg], budget });
    const turn2 = pipeline.compress({ segments: [seg], budget }, turn1.state);

    // Even though content is identical, caching is disabled
    expect(turn2.cachedSegmentCount).toBe(0);
    expect(turn2.freshSegmentCount).toBe(1);
    // But state still tracks turn number
    expect(turn2.state.turnNumber).toBe(2);
  });

  it('metrics reuse previous turn values when all segments cached', () => {
    const pipeline = createIncrementalPipeline({
      stages: [createFormatStage()],
    });

    const segments = [
      makeSegment({ id: 'data', content: jsonContent(sampleData) }),
    ];
    const budget = makeBudget();

    const turn1 = pipeline.compress({ segments, budget });
    const turn2 = pipeline.compress({ segments, budget }, turn1.state);

    // All cached -> metrics should reflect last turn's real values, not zeros
    expect(turn2.result.metrics.totalTokensIn).toBe(turn1.result.metrics.totalTokensIn);
    expect(turn2.result.metrics.totalTokensOut).toBe(turn1.result.metrics.totalTokensOut);
    expect(turn2.result.metrics.cached).toBe(true);
  });

  it('metrics are fresh (not cached) when segments change', () => {
    const pipeline = createIncrementalPipeline({
      stages: [createFormatStage()],
    });

    const budget = makeBudget();
    const turn1 = pipeline.compress({
      segments: [makeSegment({ id: 'a', content: jsonContent(sampleData) })],
      budget,
    });

    const turn2 = pipeline.compress({
      segments: [makeSegment({ id: 'a', content: jsonContent(sampleData2) })],
      budget,
    }, turn1.state);

    expect(turn2.result.metrics.totalTokensIn).toBeGreaterThan(0);
    expect(turn2.result.metrics.cached).toBeUndefined();
  });

  it('mixed: some cached, some fresh, order preserved', () => {
    const pipeline = createIncrementalPipeline({
      stages: [createUppercaser()],
    });

    const seg1 = makeSegment({ id: 'a', content: 'first' });
    const seg2 = makeSegment({ id: 'b', content: 'second' });
    const seg3 = makeSegment({ id: 'c', content: 'third' });
    const budget = makeBudget();

    const turn1 = pipeline.compress({ segments: [seg1, seg2, seg3], budget });

    // Change middle segment only
    const seg2Changed = makeSegment({ id: 'b', content: 'changed' });
    const turn2 = pipeline.compress({ segments: [seg1, seg2Changed, seg3], budget }, turn1.state);

    expect(turn2.cachedSegmentCount).toBe(2);
    expect(turn2.freshSegmentCount).toBe(1);

    // Order preserved
    expect(turn2.result.segments.map(s => s.id)).toEqual(['a', 'b', 'c']);
    expect(turn2.result.segments[0].content).toBe('FIRST');   // cached
    expect(turn2.result.segments[1].content).toBe('CHANGED'); // fresh
    expect(turn2.result.segments[2].content).toBe('THIRD');   // cached
  });

  it('empty segments list', () => {
    const pipeline = createIncrementalPipeline({
      stages: [createFormatStage()],
    });

    const budget = makeBudget();
    const result = pipeline.compress({ segments: [], budget });

    expect(result.result.segments).toHaveLength(0);
    expect(result.cachedSegmentCount).toBe(0);
    expect(result.freshSegmentCount).toBe(0);
    expect(result.state.turnNumber).toBe(1);
  });

  it('single segment, unchanged between turns', () => {
    const pipeline = createIncrementalPipeline({
      stages: [createUppercaser()],
    });

    const seg = makeSegment({ id: 'only', content: 'stable content' });
    const budget = makeBudget();

    const turn1 = pipeline.compress({ segments: [seg], budget });
    const turn2 = pipeline.compress({ segments: [seg], budget }, turn1.state);

    expect(turn2.cachedSegmentCount).toBe(1);
    expect(turn2.freshSegmentCount).toBe(0);
    expect(turn2.result.segments[0].content).toBe(turn1.result.segments[0].content);
  });

  it('content change detected by hash difference', () => {
    const pipeline = createIncrementalPipeline({
      stages: [createUppercaser()],
    });

    const budget = makeBudget();

    const turn1 = pipeline.compress({
      segments: [makeSegment({ id: 'a', content: 'version 1' })],
      budget,
    });

    const turn2 = pipeline.compress({
      segments: [makeSegment({ id: 'a', content: 'version 2' })],
      budget,
    }, turn1.state);

    expect(turn2.freshSegmentCount).toBe(1);
    expect(turn2.cachedSegmentCount).toBe(0);
    expect(turn2.result.segments[0].content).toBe('VERSION 2');
  });

  it('cache hit count matches expected', () => {
    const pipeline = createIncrementalPipeline({
      stages: [createUppercaser()],
    });

    const segments = [
      makeSegment({ id: 'a', content: 'one' }),
      makeSegment({ id: 'b', content: 'two' }),
      makeSegment({ id: 'c', content: 'three' }),
      makeSegment({ id: 'd', content: 'four' }),
    ];
    const budget = makeBudget();

    const turn1 = pipeline.compress({ segments, budget });

    // Change 2 of 4 segments
    const modifiedSegments = [
      makeSegment({ id: 'a', content: 'one' }),         // unchanged
      makeSegment({ id: 'b', content: 'two modified' }), // changed
      makeSegment({ id: 'c', content: 'three' }),        // unchanged
      makeSegment({ id: 'd', content: 'four modified' }),  // changed
    ];

    const turn2 = pipeline.compress({ segments: modifiedSegments, budget }, turn1.state);

    expect(turn2.cachedSegmentCount).toBe(2);
    expect(turn2.freshSegmentCount).toBe(2);
  });

  it('pipeline stages still execute correctly on fresh segments', () => {
    const pipeline = createIncrementalPipeline({
      stages: [createFormatStage(), createUppercaser()],
    });

    const segments = [
      makeSegment({ id: 'data', content: jsonContent(sampleData) }),
    ];
    const budget = makeBudget();

    const turn1 = pipeline.compress({ segments, budget });

    // The content should be format-compressed then uppercased
    const content = turn1.result.segments[0].content;
    expect(content).toBe(content.toUpperCase()); // uppercaser ran
    expect(content).not.toBe(jsonContent(sampleData).toUpperCase()); // format stage changed shape

    // On second turn with changed data, stages should still execute
    const newSegments = [
      makeSegment({ id: 'data', content: jsonContent(sampleData2) }),
    ];
    const turn2 = pipeline.compress({ segments: newSegments, budget }, turn1.state);

    expect(turn2.freshSegmentCount).toBe(1);
    const content2 = turn2.result.segments[0].content;
    expect(content2).toBe(content2.toUpperCase());
    expect(content2).not.toBe(content); // different data
  });

  it('all state Maps match segment count across additions and removals', () => {
    const pipeline = createIncrementalPipeline({
      stages: [createUppercaser()],
    });
    const budget = makeBudget();

    // Turn 1: [a, b, c]
    const turn1 = pipeline.compress({
      segments: [
        makeSegment({ id: 'a', content: 'alpha' }),
        makeSegment({ id: 'b', content: 'beta' }),
        makeSegment({ id: 'c', content: 'gamma' }),
      ],
      budget,
    });
    expect(turn1.state.segmentHashes.size).toBe(3);
    expect(turn1.state.compressedSegments.size).toBe(3);
    expect(turn1.state.perSegmentOutputs.size).toBe(3);

    // Turn 2: [a, b, c, d] — addition
    const turn2 = pipeline.compress({
      segments: [
        makeSegment({ id: 'a', content: 'alpha' }),
        makeSegment({ id: 'b', content: 'beta' }),
        makeSegment({ id: 'c', content: 'gamma' }),
        makeSegment({ id: 'd', content: 'delta' }),
      ],
      budget,
    }, turn1.state);
    expect(turn2.state.segmentHashes.size).toBe(4);
    expect(turn2.state.compressedSegments.size).toBe(4);
    expect(turn2.state.perSegmentOutputs.size).toBe(4);

    // Turn 3: [a, d] — removal of b, c
    const turn3 = pipeline.compress({
      segments: [
        makeSegment({ id: 'a', content: 'alpha' }),
        makeSegment({ id: 'd', content: 'delta' }),
      ],
      budget,
    }, turn2.state);
    expect(turn3.state.segmentHashes.size).toBe(2);
    expect(turn3.state.compressedSegments.size).toBe(2);
    expect(turn3.state.perSegmentOutputs.size).toBe(2);

    // Verify removed IDs are gone from ALL maps
    expect(turn3.state.segmentHashes.has('b')).toBe(false);
    expect(turn3.state.segmentHashes.has('c')).toBe(false);
    expect(turn3.state.compressedSegments.has('b')).toBe(false);
    expect(turn3.state.compressedSegments.has('c')).toBe(false);
    expect(turn3.state.perSegmentOutputs.has('b')).toBe(false);
    expect(turn3.state.perSegmentOutputs.has('c')).toBe(false);
  });

  it('state is self-contained (can be serialized and restored conceptually)', () => {
    const pipeline = createIncrementalPipeline({
      stages: [createUppercaser()],
    });

    const seg = makeSegment({ id: 'a', content: 'test data' });
    const budget = makeBudget();

    const turn1 = pipeline.compress({ segments: [seg], budget });

    // Simulate serialization round-trip by creating a new state from the maps
    const serializedState: PipelineState = {
      segmentHashes: new Map(turn1.state.segmentHashes),
      compressedSegments: new Map(turn1.state.compressedSegments),
      perSegmentOutputs: new Map(turn1.state.perSegmentOutputs),
      perSegmentOutputHashes: new Map(turn1.state.perSegmentOutputHashes),
      lastMetrics: { ...turn1.state.lastMetrics },
      turnNumber: turn1.state.turnNumber,
      configFingerprint: turn1.state.configFingerprint,
    };

    const turn2 = pipeline.compress({ segments: [seg], budget }, serializedState);

    expect(turn2.cachedSegmentCount).toBe(1);
    expect(turn2.freshSegmentCount).toBe(0);
    expect(turn2.result.segments[0].content).toBe('TEST DATA');
  });
});
