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
        'cot-distillation',
        'exact-dedup',
        'fuzzy-dedup',
        'heuristic-pruning',
        'budget-allocator',
      ]);
    });

    it('orders all per-segment stages before cross-segment stages in every preset', () => {
      // Interleaved scopes make batch and incremental pipelines diverge
      // (incremental partitions by scope) — presets must never interleave.
      for (const preset of ['fast', 'balanced', 'maximum'] as const) {
        const { stages } = createOptimizedPipeline({ preset, model: 'claude-sonnet-4' });
        let seenCross: string | undefined;
        for (const stage of stages) {
          // Undeclared scope counts as cross-segment (the safe default)
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

    it('maximum preset has hierarchy + graph + all balanced stages', () => {
      const { preset, stageNames } = createOptimizedPipeline({ preset: 'maximum' });
      expect(preset).toBe('maximum');
      expect(stageNames[0]).toBe('hierarchy-formatter');
      expect(stageNames[1]).toBe('graph-serializer');
      expect(stageNames).toContain('format-compression');
      expect(stageNames).toContain('heuristic-pruning');
      expect(stageNames[stageNames.length - 1]).toBe('budget-allocator');
    });

    it('omits the generic format stage when the format-selector is present', () => {
      const { stageNames } = createOptimizedPipeline({ preset: 'maximum', model: 'gemma-2-9b' });
      expect(stageNames).toContain('format-selector');
      expect(stageNames).not.toContain('format-compression');
    });

    it('preserves compact JSON end-to-end for prefersJson models', () => {
      const { pipeline } = createOptimizedPipeline({ preset: 'maximum', model: 'gemma-2-9b' });
      const json = JSON.stringify({ name: 'Alice', role: 'researcher', score: 92 }, null, 2);
      const result = pipeline.compress({
        segments: [{ id: 'mem', content: json, role: 'memory', priority: 1 }],
        budget: { maxTokens: 4096, outputReserve: 0 },
        model: 'gemma-2-9b',
      });

      // The selector's compact-JSON choice must survive the whole pipeline —
      // previously the generic format stage rewrote it into tabular/nested.
      expect(() => JSON.parse(result.segments[0].content)).not.toThrow();
      expect(result.segments[0].content).toBe('{"name":"Alice","role":"researcher","score":92}');
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
