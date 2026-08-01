/**
 * Tests for createPipeline (pipeline/pipeline.ts) and the metric utilities
 * it reports through: computeStageMetrics, aggregateMetrics, formatMetricsSummary.
 */

import { describe, it, expect } from 'vitest';
import { createPipeline } from '../src/pipeline/pipeline.js';
import type { CompressionStage, PromptSegment, BudgetConfig } from '../src/pipeline/types.js';
import { computeStageMetrics, aggregateMetrics, formatMetricsSummary } from '../src/pipeline/metrics.js';
import { seg } from './helpers.js';

function makeBudget(overrides?: Partial<BudgetConfig>): BudgetConfig {
  return { maxTokens: 4096, outputReserve: 0, ...overrides };
}

function createWhitespaceRemover(): CompressionStage {
  return {
    name: 'whitespace-remover',
    execute(segments: PromptSegment[]) {
      return {
        segments: segments.map(s => ({ ...s, content: s.content.replace(/\s+/g, ' ').trim() })),
      };
    },
  };
}

function createUppercaser(): CompressionStage {
  return {
    name: 'uppercaser',
    execute(segments: PromptSegment[]) {
      return { segments: segments.map(s => ({ ...s, content: s.content.toUpperCase() })) };
    },
  };
}

function createFailingStage(): CompressionStage {
  return {
    name: 'failing-stage',
    execute() {
      throw new Error('Stage failed');
    },
  };
}

function createDroppingStage(idsToDrop: string[]): CompressionStage {
  return {
    name: 'dropping-stage',
    execute(segments: PromptSegment[]) {
      return { segments: segments.filter(s => !idsToDrop.includes(s.id)) };
    },
  };
}

function createAddingStage(segment: PromptSegment): CompressionStage {
  return {
    name: 'adding-stage',
    execute(segments: PromptSegment[]) {
      return { segments: [...segments, segment] };
    },
  };
}

describe('createPipeline', () => {
  it('passes segments through unchanged with no stages', () => {
    const pipeline = createPipeline({ stages: [] });

    const result = pipeline.compress({ segments: [seg('a', 'hello world')], budget: makeBudget() });

    expect(result.segments).toHaveLength(1);
    expect(result.segments[0].content).toBe('hello world');
    expect(result.metrics.reductionPercent).toBe(0);
  });

  it('applies a single stage', () => {
    const pipeline = createPipeline({ stages: [createWhitespaceRemover()] });

    const result = pipeline.compress({ segments: [seg('a', 'hello    world    foo')], budget: makeBudget() });

    expect(result.segments[0].content).toBe('hello world foo');
  });

  it('applies multiple stages in configured order', () => {
    const pipeline = createPipeline({ stages: [createWhitespaceRemover(), createUppercaser()] });

    const result = pipeline.compress({ segments: [seg('a', 'hello    world')], budget: makeBudget() });

    expect(result.segments[0].content).toBe('HELLO WORLD');
    expect(result.metrics.stages.map(s => s.name)).toEqual(['whitespace-remover', 'uppercaser']);
  });

  it('skips locked segments during compression', () => {
    const pipeline = createPipeline({ stages: [createUppercaser()] });
    const segments = [seg('sys', 'system prompt', 'system', { locked: true }), seg('mem', 'memory data')];

    const result = pipeline.compress({ segments, budget: makeBudget() });

    expect(result.segments[0].content).toBe('system prompt');
    expect(result.segments[1].content).toBe('MEMORY DATA');
  });

  it('preserves original segment order after recombination', () => {
    const pipeline = createPipeline({ stages: [createUppercaser()] });
    const segments = [
      seg('a', 'first', 'memory', { locked: true }),
      seg('b', 'second'),
      seg('c', 'third', 'memory', { locked: true }),
      seg('d', 'fourth'),
    ];

    const result = pipeline.compress({ segments, budget: makeBudget() });

    expect(result.segments.map(s => s.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(result.segments.map(s => s.content)).toEqual(['first', 'SECOND', 'third', 'FOURTH']);
  });

  it('passes a stage through and continues when it throws', () => {
    const pipeline = createPipeline({ stages: [createFailingStage(), createUppercaser()] });

    const result = pipeline.compress({ segments: [seg('a', 'hello')], budget: makeBudget() });

    expect(result.segments[0].content).toBe('HELLO');
    expect(result.metrics.stages[0].error).toBe(true);
    expect(result.metrics.stages[0].tokensIn).toBe(result.metrics.stages[0].tokensOut);
    expect(result.metrics.stages[1].error).toBeUndefined();
  });

  it('warns with the error message when a stage throws an Error', () => {
    const warnings: string[] = [];
    const pipeline = createPipeline({
      stages: [createFailingStage()],
      logger: { warn: m => warnings.push(m) },
    });

    pipeline.compress({ segments: [seg('a', 'hi')], budget: makeBudget() });

    expect(warnings.some(w => w.includes('Stage failed'))).toBe(true);
  });

  it('warns with the stringified reason when a stage throws a non-Error value', () => {
    const warnings: string[] = [];
    const stringThrower: CompressionStage = {
      name: 'string-thrower',
      execute() {
        throw 'boom';
      },
    };
    const pipeline = createPipeline({ stages: [stringThrower], logger: { warn: m => warnings.push(m) } });

    const result = pipeline.compress({ segments: [seg('a', 'hi')], budget: makeBudget() });

    expect(result.segments[0].content).toBe('hi');
    expect(result.metrics.stages[0].error).toBe(true);
    expect(warnings.some(w => w.includes('boom'))).toBe(true);
  });

  it('skips remaining stages and warns when the pipeline timeout is already exceeded', () => {
    const ALREADY_EXPIRED_MS = -1;
    const warnings: string[] = [];
    const pipeline = createPipeline({
      stages: [createUppercaser()],
      timeoutMs: ALREADY_EXPIRED_MS,
      logger: { warn: m => warnings.push(m) },
    });

    const result = pipeline.compress({ segments: [seg('a', 'hello')], budget: makeBudget() });

    expect(result.segments[0].content).toBe('hello');
    expect(result.metrics.stages.some(s => s.name === 'uppercaser')).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('timeout');
    expect(warnings[0]).toContain('uppercaser');
  });

  it('builds a source map entry per mutable segment in debug mode', () => {
    const pipeline = createPipeline({ stages: [createUppercaser()], debug: true });

    const result = pipeline.compress({ segments: [seg('a', 'hello')], budget: makeBudget() });

    expect(result.sourceMap).toHaveLength(1);
    expect(result.sourceMap![0]).toMatchObject({ segmentId: 'a', original: 'hello', compressed: 'HELLO' });
  });

  it('omits the source map when debug is off', () => {
    const pipeline = createPipeline({ stages: [createUppercaser()] });

    const result = pipeline.compress({ segments: [seg('a', 'hello')], budget: makeBudget() });

    expect(result.sourceMap).toBeUndefined();
  });

  it('attributes content changes to the stages that made them', () => {
    const pipeline = createPipeline({
      stages: [createWhitespaceRemover(), createUppercaser()],
      debug: true,
    });
    const segments = [seg('a', 'hello    world'), seg('b', 'CLEAN')];

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
    const segments = [seg('a', 'keep'), seg('b', 'drop me')];

    const result = pipeline.compress({ segments, budget: makeBudget() });

    expect(result.segments.map(s => s.id)).toEqual(['a']);
    expect(result.segments[0].content).toBe('KEEP');

    const b = result.sourceMap!.find(e => e.segmentId === 'b')!;
    expect(b).toMatchObject({ removed: true, removedBy: 'dropping-stage', original: 'drop me', compressed: '' });
  });

  it('marks stage-added segments in the source map and appends them to output', () => {
    const added = seg('summary', 'a summary');
    const pipeline = createPipeline({
      stages: [createAddingStage(added), createUppercaser()],
      debug: true,
    });

    const result = pipeline.compress({ segments: [seg('a', 'original')], budget: makeBudget() });

    expect(result.segments.map(s => s.id)).toEqual(['a', 'summary']);
    expect(result.segments[1].content).toBe('A SUMMARY');

    const entry = result.sourceMap!.find(e => e.segmentId === 'summary')!;
    expect(entry).toMatchObject({ addedBy: 'adding-stage', original: '', compressed: 'A SUMMARY' });
    expect(entry.changedBy).toEqual(['uppercaser']);
  });

  it('excludes locked segments from the debug source map', () => {
    const pipeline = createPipeline({ stages: [createUppercaser()], debug: true });
    const segments = [seg('sys', 'locked', 'system', { locked: true }), seg('mem', 'mutable')];

    const result = pipeline.compress({ segments, budget: makeBudget() });

    expect(result.sourceMap).toHaveLength(1);
    expect(result.sourceMap![0].segmentId).toBe('mem');
  });

  it('warns when the budget exceeds the model context window', () => {
    const warnings: string[] = [];
    const pipeline = createPipeline({ stages: [], logger: { warn: m => warnings.push(m) } });

    pipeline.compress({
      segments: [seg('a', 'hello')],
      budget: makeBudget({ maxTokens: 100_000 }),
      model: 'gemma-2-9b',
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('context window');
    expect(warnings[0]).toContain('8192');
  });

  it('threads the query from input to stage context', () => {
    let seenQuery: string | undefined;
    const querySpy: CompressionStage = {
      name: 'query-spy',
      execute(segments, context) {
        seenQuery = context.query;
        return { segments };
      },
    };
    const pipeline = createPipeline({ stages: [querySpy] });

    pipeline.compress({
      segments: [seg('a', 'hello')],
      budget: makeBudget(),
      query: 'What is the launch date?',
    });

    expect(seenQuery).toBe('What is the launch date?');
  });

  it('subtracts locked segment tokens from the budget stages receive', () => {
    const LOCKED_CHARS = 40;
    const CHARS_PER_TOKEN = 4;
    let seenMaxTokens: number | undefined;
    const budgetSpy: CompressionStage = {
      name: 'budget-spy',
      execute(segments, context) {
        seenMaxTokens = context.budget.maxTokens;
        return { segments };
      },
    };
    const pipeline = createPipeline({ stages: [budgetSpy] });
    const segments = [seg('sys', 'x'.repeat(LOCKED_CHARS), 'system', { locked: true }), seg('mem', 'mutable')];

    pipeline.compress({ segments, budget: makeBudget({ maxTokens: 100 }) });

    expect(seenMaxTokens).toBe(100 - LOCKED_CHARS / CHARS_PER_TOKEN);
  });

  it('rejects an invalid budget via zod', () => {
    const pipeline = createPipeline({ stages: [] });

    expect(() =>
      pipeline.compress({
        segments: [seg('a', 'hello')],
        budget: { maxTokens: -1, outputReserve: 0 } as BudgetConfig,
      }),
    ).toThrow();
  });

  it('reports a positive reduction when a stage shrinks content', () => {
    const pipeline = createPipeline({ stages: [createWhitespaceRemover()] });

    const result = pipeline.compress({
      segments: [seg('a', 'hello     world     foo     bar')],
      budget: makeBudget(),
    });

    expect(result.metrics.totalTokensIn).toBeGreaterThan(0);
    expect(result.metrics.totalTokensOut).toBeLessThan(result.metrics.totalTokensIn);
    expect(result.metrics.reductionPercent).toBeGreaterThan(0);
    expect(result.metrics.totalDurationMs).toBeGreaterThanOrEqual(0);
  });
});

describe('computeStageMetrics', () => {
  it('computes the ratio from input and output tokens', () => {
    const m = computeStageMetrics('test', 100, 60, 5.0);

    expect(m).toMatchObject({ name: 'test', tokensIn: 100, tokensOut: 60, ratio: 0.6, durationMs: 5.0 });
  });

  it('reports a ratio of 1.0 when input tokens are zero', () => {
    const m = computeStageMetrics('test', 0, 0, 1.0);

    expect(m.ratio).toBe(1.0);
  });
});

describe('aggregateMetrics', () => {
  it('carries first-stage input and last-stage output into the totals', () => {
    const agg = aggregateMetrics([
      computeStageMetrics('a', 100, 80, 2.0),
      computeStageMetrics('b', 80, 50, 3.0),
    ]);

    expect(agg).toMatchObject({
      totalTokensIn: 100,
      totalTokensOut: 50,
      reductionPercent: 50,
      totalDurationMs: 5.0,
    });
    expect(agg.stages).toHaveLength(2);
  });

  it('returns zeroed totals with a passthrough ratio for an empty stage list', () => {
    const agg = aggregateMetrics([]);

    expect(agg).toMatchObject({
      totalTokensIn: 0,
      totalTokensOut: 0,
      overallRatio: 1.0,
      reductionPercent: 0,
      totalDurationMs: 0,
    });
    expect(agg.stages).toEqual([]);
  });
});

describe('formatMetricsSummary', () => {
  it('renders the totals line and one line per stage', () => {
    const summary = formatMetricsSummary(
      aggregateMetrics([
        computeStageMetrics('format', 1000, 700, 2.5),
        computeStageMetrics('dedup', 700, 600, 1.2),
      ]),
    );

    const lines = summary.split('\n');
    expect(lines[0]).toContain('1000 → 600 tokens');
    expect(lines[1]).toContain('format: 1000 → 700');
    expect(lines[2]).toContain('dedup: 700 → 600');
  });

  it('flags only the stages that errored and passed through', () => {
    const summary = formatMetricsSummary(
      aggregateMetrics([
        computeStageMetrics('ok', 100, 80, 1.0),
        computeStageMetrics('broken', 80, 80, 1.0, true),
      ]),
    );

    const lines = summary.split('\n');
    expect(lines[1]).not.toContain('[error');
    expect(lines[2]).toContain('[error: passthrough]');
  });
});
