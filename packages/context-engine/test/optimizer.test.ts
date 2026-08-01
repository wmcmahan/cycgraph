/**
 * Tests for budget/optimizer — preset selection and pipeline assembly
 * for createOptimizedPipeline.
 */

import { describe, it, expect } from 'vitest';
import { createOptimizedPipeline } from '../src/budget/optimizer.js';
import { DefaultTokenCounter } from '../src/providers/defaults.js';
import { seg } from './helpers.js';

const counter = new DefaultTokenCounter();

describe('createOptimizedPipeline', () => {
  describe('preset stage lists', () => {
    it('builds the fast preset from three stages', () => {
      const { preset, stageNames } = createOptimizedPipeline({ preset: 'fast' });
      expect(preset).toBe('fast');
      expect(stageNames).toEqual(['format-compression', 'exact-dedup', 'budget-allocator']);
    });

    it('builds the balanced preset from six stages', () => {
      const { preset, stageNames } = createOptimizedPipeline({ preset: 'balanced' });
      expect(preset).toBe('balanced');
      expect(stageNames).toEqual([
        'format-compression',
        'cot-distillation',
        'exact-dedup',
        'fuzzy-dedup',
        'heuristic-pruning',
        'budget-allocator',
      ]);
    });

    it('leads the maximum preset with hierarchy and graph formatters and ends with the allocator', () => {
      const { preset, stageNames } = createOptimizedPipeline({ preset: 'maximum' });
      expect(preset).toBe('maximum');
      expect(stageNames[0]).toBe('hierarchy-formatter');
      expect(stageNames[1]).toBe('graph-serializer');
      expect(stageNames).toContain('format-compression');
      expect(stageNames).toContain('heuristic-pruning');
      expect(stageNames[stageNames.length - 1]).toBe('budget-allocator');
    });

    it('adds the format-selector to the maximum preset when a model is given', () => {
      const { stageNames } = createOptimizedPipeline({ preset: 'maximum', model: 'claude-sonnet-4-6' });
      expect(stageNames).toContain('format-selector');
    });

    it('omits the generic format stage when the format-selector is present', () => {
      const { stageNames } = createOptimizedPipeline({ preset: 'maximum', model: 'gemma-2-9b' });
      expect(stageNames).toContain('format-selector');
      expect(stageNames).not.toContain('format-compression');
    });

    it('orders every per-segment stage before any cross-segment stage in each preset', () => {
      for (const preset of ['fast', 'balanced', 'maximum'] as const) {
        const { stages } = createOptimizedPipeline({ preset, model: 'claude-sonnet-4' });

        let seenCross: string | undefined;
        for (const stage of stages) {
          if (stage.scope !== 'per-segment') {
            seenCross ??= stage.name;
          } else {
            expect(
              seenCross,
              `preset "${preset}": per-segment stage "${stage.name}" follows cross-segment stage "${seenCross}"`,
            ).toBeUndefined();
          }
        }
      }
    });
  });

  describe('auto-select from latency budget', () => {
    it('selects fast at or below 5ms', () => {
      expect(createOptimizedPipeline({ maxLatencyMs: 3 }).preset).toBe('fast');
      expect(createOptimizedPipeline({ maxLatencyMs: 5 }).preset).toBe('fast');
    });

    it('selects balanced between 6 and 50ms', () => {
      expect(createOptimizedPipeline({ maxLatencyMs: 20 }).preset).toBe('balanced');
      expect(createOptimizedPipeline({ maxLatencyMs: 50 }).preset).toBe('balanced');
    });

    it('selects maximum above 50ms', () => {
      expect(createOptimizedPipeline({ maxLatencyMs: 100 }).preset).toBe('maximum');
    });

    it('defaults to balanced when no latency budget is given', () => {
      expect(createOptimizedPipeline().preset).toBe('balanced');
    });
  });

  describe('execution', () => {
    it('compresses JSON below its original token count', () => {
      const pipeline = createOptimizedPipeline({ preset: 'fast' });
      const json = JSON.stringify([{ name: 'Alice', score: 92 }, { name: 'Bob', score: 87 }], null, 2);

      const result = pipeline.compress({
        segments: [seg('a', json)],
        budget: { maxTokens: 4096, outputReserve: 0 },
      });

      expect(counter.countTokens(result.segments[0].content)).toBeLessThan(counter.countTokens(json));
    });

    it('reduces at least as much under the balanced preset as under fast', () => {
      const verbose =
        'It should be noted that in order to improve the system we basically need to restructure. ' +
        'The system uses a graph-based engine. The system uses a graph-based engine.';
      const budget = { maxTokens: 20, outputReserve: 0 };

      const fast = createOptimizedPipeline({ preset: 'fast' }).compress({ segments: [seg('a', verbose)], budget });
      const balanced = createOptimizedPipeline({ preset: 'balanced' }).compress({ segments: [seg('a', verbose)], budget });

      expect(counter.countTokens(balanced.segments[0].content)).toBeLessThanOrEqual(counter.countTokens(fast.segments[0].content));
    });

    it('concentrates budget on the query-relevant segment', () => {
      const pipeline = createOptimizedPipeline({ preset: 'fast' });
      const segments = [
        seg('relevant', 'Northgate Holdings is headquartered in Denver and acquired Meridian Systems in 2019. '.repeat(3), 'history'),
        seg('noise', 'Batch schedulers queue jobs by priority and resource requirements across the cluster nodes. '.repeat(3), 'history'),
      ];
      const budget = { maxTokens: 80, outputReserve: 0 };

      const withQuery = pipeline.compress({ segments, budget, query: 'Where is Northgate Holdings headquartered?' });
      const withoutQuery = pipeline.compress({ segments, budget });

      const relevant = withQuery.segments.find(s => s.id === 'relevant')!;
      const noise = withQuery.segments.find(s => s.id === 'noise')!;
      expect(relevant.content).toContain('Denver');
      expect(noise.content.length).toBeLessThan(relevant.content.length);
      expect(withoutQuery.segments.map(s => s.content)).not.toEqual(withQuery.segments.map(s => s.content));
    });

    it('preserves the selector-chosen compact JSON end to end for a prefersJson model', () => {
      const pipeline = createOptimizedPipeline({ preset: 'maximum', model: 'gemma-2-9b' });
      const json = JSON.stringify({ name: 'Alice', role: 'researcher', score: 92 }, null, 2);

      const result = pipeline.compress({
        segments: [seg('mem', json)],
        budget: { maxTokens: 4096, outputReserve: 0 },
        model: 'gemma-2-9b',
      });

      expect(result.segments[0].content).toBe('{"name":"Alice","role":"researcher","score":92}');
    });

    it('forwards the logger and timeout to the underlying pipeline', () => {
      const warnings: string[] = [];
      const pipeline = createOptimizedPipeline({
        preset: 'fast',
        logger: { warn: m => warnings.push(m) },
        timeoutMs: 5_000,
      });

      pipeline.compress({
        segments: [seg('a', 'hello world')],
        budget: { maxTokens: 10_000_000, outputReserve: 0 },
        model: 'claude-sonnet-4-6',
      });

      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('context window');
    });
  });

  describe('deprecated pipeline self-reference', () => {
    it('exposes a compress method on the self-reference', () => {
      const { pipeline } = createOptimizedPipeline({ preset: 'fast' });

      const result = pipeline.compress({
        segments: [seg('a', 'hello world')],
        budget: { maxTokens: 100, outputReserve: 0 },
      });

      expect(result.segments[0].content).toBeDefined();
    });

    it('points the self-reference at the pipeline itself', () => {
      const { pipeline } = createOptimizedPipeline({ preset: 'fast' });
      expect(pipeline.pipeline).toBe(pipeline);
    });
  });
});
