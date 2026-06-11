import { describe, it, expect } from 'vitest';
import { createOptimizedPipeline } from '../src/budget/optimizer.js';
import type { PromptSegment } from '../src/pipeline/types.js';
import { DefaultTokenCounter } from '../src/providers/defaults.js';

const counter = new DefaultTokenCounter();

function makeSegment(id: string, content: string): PromptSegment {
  return { id, content, role: 'memory', priority: 1, locked: false };
}

describe('createOptimizedPipeline', () => {
  describe('presets', () => {
    it('fast preset has 3 stages', () => {
      const { preset, stageNames } = createOptimizedPipeline({ preset: 'fast' });
      expect(preset).toBe('fast');
      expect(stageNames).toEqual([
        'format-compression',
        'exact-dedup',
        'budget-allocator',
      ]);
    });

    it('balanced preset has 6 stages', () => {
      const { preset, stageNames } = createOptimizedPipeline({ preset: 'balanced' });
      expect(preset).toBe('balanced');
      expect(stageNames).toEqual([
        'format-compression',
        'exact-dedup',
        'fuzzy-dedup',
        'cot-distillation',
        'heuristic-pruning',
        'budget-allocator',
      ]);
    });

    it('maximum preset has hierarchy + graph + all balanced stages', () => {
      const { preset, stageNames } = createOptimizedPipeline({ preset: 'maximum' });
      expect(preset).toBe('maximum');
      expect(stageNames[0]).toBe('hierarchy-formatter');
      expect(stageNames[1]).toBe('graph-serializer');
      expect(stageNames).toContain('format-compression');
      expect(stageNames).toContain('heuristic-pruning');
      expect(stageNames[stageNames.length - 1]).toBe('budget-allocator');
    });

    it('maximum with model adds format-selector', () => {
      const { stageNames } = createOptimizedPipeline({
        preset: 'maximum',
        model: 'claude-sonnet-4-6',
      });
      expect(stageNames).toContain('format-selector');
    });
  });

  describe('auto-select from latency budget', () => {
    it('selects fast for <= 5ms', () => {
      const { preset } = createOptimizedPipeline({ maxLatencyMs: 3 });
      expect(preset).toBe('fast');
    });

    it('selects balanced for 6-50ms', () => {
      const { preset } = createOptimizedPipeline({ maxLatencyMs: 20 });
      expect(preset).toBe('balanced');
    });

    it('selects maximum for > 50ms', () => {
      const { preset } = createOptimizedPipeline({ maxLatencyMs: 100 });
      expect(preset).toBe('maximum');
    });

    it('defaults to balanced when no latency budget', () => {
      const { preset } = createOptimizedPipeline();
      expect(preset).toBe('balanced');
    });
  });

  describe('pipeline execution', () => {
    it('fast preset compresses JSON', () => {
      const { pipeline } = createOptimizedPipeline({ preset: 'fast' });
      const json = JSON.stringify([
        { name: 'Alice', score: 92 },
        { name: 'Bob', score: 87 },
      ], null, 2);

      const result = pipeline.compress({
        segments: [makeSegment('a', json)],
        budget: { maxTokens: 4096, outputReserve: 0 },
      });

      expect(counter.countTokens(result.segments[0].content)).toBeLessThan(counter.countTokens(json));
    });

    it('balanced preset reduces more than fast', () => {
      const verbose = 'It should be noted that in order to improve the system we basically need to restructure. ' +
        'The system uses a graph-based engine. The system uses a graph-based engine.';

      const fast = createOptimizedPipeline({ preset: 'fast' });
      const balanced = createOptimizedPipeline({ preset: 'balanced' });

      const fastResult = fast.pipeline.compress({
        segments: [makeSegment('a', verbose)],
        budget: { maxTokens: 20, outputReserve: 0 },
      });
      const balancedResult = balanced.pipeline.compress({
        segments: [makeSegment('a', verbose)],
        budget: { maxTokens: 20, outputReserve: 0 },
      });

      const fastTokens = counter.countTokens(fastResult.segments[0].content);
      const balancedTokens = counter.countTokens(balancedResult.segments[0].content);
      expect(balancedTokens).toBeLessThanOrEqual(fastTokens);
    });
  });
});
