import { describe, it, expect } from 'vitest';
import { createPipeline } from '../src/pipeline/pipeline.js';
import type { CompressionStage, PromptSegment, StageContext, BudgetConfig } from '../src/pipeline/types.js';
import { computeStageMetrics, aggregateMetrics, formatMetricsSummary } from '../src/pipeline/metrics.js';

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

/** Stage that removes all whitespace from content (simple compressor). */
function createWhitespaceRemover(): CompressionStage {
  return {
    name: 'whitespace-remover',
    execute(segments: PromptSegment[]) {
      return {
        segments: segments.map(s => ({
          ...s,
          content: s.content.replace(/\s+/g, ' ').trim(),
        })),
      };
    },
  };
}

/** Stage that uppercases content (for ordering verification). */
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

/** Stage that always throws. */
function createFailingStage(): CompressionStage {
  return {
    name: 'failing-stage',
    execute() {
      throw new Error('Stage failed');
    },
  };
}

/** Stage that drops segments by id. */
function createDroppingStage(idsToDrop: string[]): CompressionStage {
  return {
    name: 'dropping-stage',
    execute(segments: PromptSegment[]) {
      return { segments: segments.filter(s => !idsToDrop.includes(s.id)) };
    },
  };
}

/** Stage that appends a new segment. */
function createAddingStage(segment: PromptSegment): CompressionStage {
  return {
    name: 'adding-stage',
    execute(segments: PromptSegment[]) {
      return { segments: [...segments, segment] };
    },
  };
}

// --- Tests ---

describe('createPipeline', () => {
  it('passes segments through unchanged with no stages', () => {
    const pipeline = createPipeline({ stages: [] });
    const segments = [makeSegment({ id: 'a', content: 'hello world' })];
    const result = pipeline.compress({ segments, budget: makeBudget() });

    expect(result.segments).toHaveLength(1);
    expect(result.segments[0].content).toBe('hello world');
    expect(result.metrics.reductionPercent).toBe(0);
  });

  it('applies a single stage', () => {
    const pipeline = createPipeline({ stages: [createWhitespaceRemover()] });
    const segments = [makeSegment({ id: 'a', content: 'hello    world    foo' })];
    const result = pipeline.compress({ segments, budget: makeBudget() });

    expect(result.segments[0].content).toBe('hello world foo');
  });

  it('applies multiple stages in order', () => {
    const pipeline = createPipeline({
      stages: [createWhitespaceRemover(), createUppercaser()],
    });
    const segments = [makeSegment({ id: 'a', content: 'hello    world' })];
    const result = pipeline.compress({ segments, budget: makeBudget() });

    // Whitespace removed first, then uppercased
    expect(result.segments[0].content).toBe('HELLO WORLD');
    expect(result.metrics.stages).toHaveLength(2);
    expect(result.metrics.stages[0].name).toBe('whitespace-remover');
    expect(result.metrics.stages[1].name).toBe('uppercaser');
  });

  it('skips locked segments during compression', () => {
    const pipeline = createPipeline({ stages: [createUppercaser()] });
    const segments = [
      makeSegment({ id: 'sys', content: 'system prompt', locked: true }),
      makeSegment({ id: 'mem', content: 'memory data' }),
    ];
    const result = pipeline.compress({ segments, budget: makeBudget() });

    expect(result.segments[0].content).toBe('system prompt'); // unchanged
    expect(result.segments[1].content).toBe('MEMORY DATA'); // compressed
  });

  it('preserves original segment order after recombination', () => {
    const pipeline = createPipeline({ stages: [createUppercaser()] });
    const segments = [
      makeSegment({ id: 'a', content: 'first', locked: true }),
      makeSegment({ id: 'b', content: 'second' }),
      makeSegment({ id: 'c', content: 'third', locked: true }),
      makeSegment({ id: 'd', content: 'fourth' }),
    ];
    const result = pipeline.compress({ segments, budget: makeBudget() });

    expect(result.segments.map(s => s.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(result.segments[0].content).toBe('first');   // locked
    expect(result.segments[1].content).toBe('SECOND');  // compressed
    expect(result.segments[2].content).toBe('third');   // locked
    expect(result.segments[3].content).toBe('FOURTH');  // compressed
  });

  it('handles graceful degradation when a stage throws', () => {
    const pipeline = createPipeline({
      stages: [createFailingStage(), createUppercaser()],
    });
    const segments = [makeSegment({ id: 'a', content: 'hello' })];
    const result = pipeline.compress({ segments, budget: makeBudget() });

    // Failing stage passed through, uppercaser still ran
    expect(result.segments[0].content).toBe('HELLO');
    expect(result.metrics.stages[0].error).toBe(true);
    expect(result.metrics.stages[0].tokensIn).toBe(result.metrics.stages[0].tokensOut);
    expect(result.metrics.stages[1].error).toBeUndefined();
  });

  it('builds source map in debug mode', () => {
    const pipeline = createPipeline({
      stages: [createUppercaser()],
      debug: true,
    });
    const segments = [makeSegment({ id: 'a', content: 'hello' })];
    const result = pipeline.compress({ segments, budget: makeBudget() });

    expect(result.sourceMap).toBeDefined();
    expect(result.sourceMap).toHaveLength(1);
    expect(result.sourceMap![0].segmentId).toBe('a');
    expect(result.sourceMap![0].original).toBe('hello');
    expect(result.sourceMap![0].compressed).toBe('HELLO');
  });

  it('does not build source map when debug is off', () => {
    const pipeline = createPipeline({ stages: [createUppercaser()] });
    const segments = [makeSegment({ id: 'a', content: 'hello' })];
    const result = pipeline.compress({ segments, budget: makeBudget() });

    expect(result.sourceMap).toBeUndefined();
  });

  it('attributes content changes to the stages that made them', () => {
    const pipeline = createPipeline({
      stages: [createWhitespaceRemover(), createUppercaser()],
      debug: true,
    });
    const segments = [
      makeSegment({ id: 'a', content: 'hello    world' }), // changed by both
      makeSegment({ id: 'b', content: 'CLEAN' }),          // changed by neither
    ];
    const result = pipeline.compress({ segments, budget: makeBudget() });

    const a = result.sourceMap!.find(e => e.segmentId === 'a')!;
    const b = result.sourceMap!.find(e => e.segmentId === 'b')!;
    expect(a.changedBy).toEqual(['whitespace-remover', 'uppercaser']);
    expect(b.changedBy).toEqual([]);
  });

  it('marks removed segments in the source map and excludes them from output', () => {
    const pipeline = createPipeline({
      stages: [createDroppingStage(['b']), createUppercaser()],
      debug: true,
    });
    const segments = [
      makeSegment({ id: 'a', content: 'keep' }),
      makeSegment({ id: 'b', content: 'drop me' }),
    ];
    const result = pipeline.compress({ segments, budget: makeBudget() });

    // The dropped segment is NOT resurrected in the output
    expect(result.segments.map(s => s.id)).toEqual(['a']);
    expect(result.segments[0].content).toBe('KEEP');

    const b = result.sourceMap!.find(e => e.segmentId === 'b')!;
    expect(b.removed).toBe(true);
    expect(b.removedBy).toBe('dropping-stage');
    expect(b.original).toBe('drop me');
    expect(b.compressed).toBe('');
  });

  it('marks stage-added segments in the source map and includes them in output', () => {
    const added = makeSegment({ id: 'summary', content: 'a summary' });
    const pipeline = createPipeline({
      stages: [createAddingStage(added), createUppercaser()],
      debug: true,
    });
    const segments = [makeSegment({ id: 'a', content: 'original' })];
    const result = pipeline.compress({ segments, budget: makeBudget() });

    expect(result.segments.map(s => s.id)).toEqual(['a', 'summary']);
    expect(result.segments[1].content).toBe('A SUMMARY');

    const entry = result.sourceMap!.find(e => e.segmentId === 'summary')!;
    expect(entry.addedBy).toBe('adding-stage');
    expect(entry.original).toBe('');
    expect(entry.compressed).toBe('A SUMMARY');
    expect(entry.changedBy).toEqual(['uppercaser']);
  });

  it('excludes locked segments from debug source map', () => {
    const pipeline = createPipeline({
      stages: [createUppercaser()],
      debug: true,
    });
    const segments = [
      makeSegment({ id: 'sys', content: 'locked', locked: true }),
      makeSegment({ id: 'mem', content: 'mutable' }),
    ];
    const result = pipeline.compress({ segments, budget: makeBudget() });

    expect(result.sourceMap).toHaveLength(1);
    expect(result.sourceMap![0].segmentId).toBe('mem');
  });

  it('warns when the budget exceeds the model context window', () => {
    const warnings: string[] = [];
    const pipeline = createPipeline({
      stages: [],
      logger: { warn: m => warnings.push(m) },
    });

    // gemma profile: 8192-token context window
    pipeline.compress({
      segments: [makeSegment({ id: 'a', content: 'hello' })],
      budget: makeBudget({ maxTokens: 100_000 }),
      model: 'gemma-2-9b',
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('context window');
    expect(warnings[0]).toContain('8192');
  });

  it('subtracts locked segment tokens from the budget stages receive', () => {
    let seenMaxTokens: number | undefined;
    const budgetSpy: CompressionStage = {
      name: 'budget-spy',
      execute(segments, context) {
        seenMaxTokens = context.budget.maxTokens;
        return { segments };
      },
    };

    const pipeline = createPipeline({ stages: [budgetSpy] });
    // DefaultTokenCounter with no model: 4 chars/token → 40 chars = 10 tokens
    const segments = [
      makeSegment({ id: 'sys', content: 'x'.repeat(40), locked: true }),
      makeSegment({ id: 'mem', content: 'mutable' }),
    ];
    pipeline.compress({ segments, budget: makeBudget({ maxTokens: 100 }) });

    expect(seenMaxTokens).toBe(90);
  });

  it('validates budget config with zod', () => {
    const pipeline = createPipeline({ stages: [] });
    const segments = [makeSegment({ id: 'a', content: 'hello' })];

    expect(() =>
      pipeline.compress({
        segments,
        budget: { maxTokens: -1, outputReserve: 0 } as BudgetConfig,
      }),
    ).toThrow();
  });

  it('reports correct overall metrics', () => {
    const pipeline = createPipeline({ stages: [createWhitespaceRemover()] });
    const segments = [
      makeSegment({ id: 'a', content: 'hello     world     foo     bar' }),
    ];
    const result = pipeline.compress({ segments, budget: makeBudget() });

    expect(result.metrics.totalTokensIn).toBeGreaterThan(0);
    expect(result.metrics.totalTokensOut).toBeLessThanOrEqual(result.metrics.totalTokensIn);
    expect(result.metrics.reductionPercent).toBeGreaterThanOrEqual(0);
    expect(result.metrics.totalDurationMs).toBeGreaterThanOrEqual(0);
  });
});

describe('computeStageMetrics', () => {
  it('computes ratio correctly', () => {
    const m = computeStageMetrics('test', 100, 60, 5.0);
    expect(m.ratio).toBe(0.6);
    expect(m.name).toBe('test');
    expect(m.durationMs).toBe(5.0);
  });

  it('handles zero input tokens', () => {
    const m = computeStageMetrics('test', 0, 0, 1.0);
    expect(m.ratio).toBe(1.0);
  });
});

describe('aggregateMetrics', () => {
  it('aggregates multiple stages', () => {
    const stages = [
      computeStageMetrics('a', 100, 80, 2.0),
      computeStageMetrics('b', 80, 50, 3.0),
    ];
    const agg = aggregateMetrics(stages);

    expect(agg.totalTokensIn).toBe(100);
    expect(agg.totalTokensOut).toBe(50);
    expect(agg.reductionPercent).toBe(50);
    expect(agg.totalDurationMs).toBe(5.0);
    expect(agg.stages).toHaveLength(2);
  });
});

describe('formatMetricsSummary', () => {
  it('produces readable output', () => {
    const agg = aggregateMetrics([
      computeStageMetrics('format', 1000, 700, 2.5),
      computeStageMetrics('dedup', 700, 600, 1.2),
    ]);
    const summary = formatMetricsSummary(agg);

    expect(summary).toContain('1000');
    expect(summary).toContain('600');
    expect(summary).toContain('format');
    expect(summary).toContain('dedup');
  });
});
