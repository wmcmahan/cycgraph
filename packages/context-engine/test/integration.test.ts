/**
 * Cross-module smoke tests: real compression stages composed through
 * createPipeline against representative orchestrator memory fixtures.
 */

import { describe, it, expect } from 'vitest';
import {
  createPipeline,
  createFormatStage,
  createExactDedupStage,
  createFuzzyDedupStage,
  createCotDistillationStage,
  createHeuristicPruningStage,
  createAllocatorStage,
  applyCachePolicy,
  DefaultTokenCounter,
} from '../src/index.js';
import type { PromptSegment, BudgetConfig } from '../src/index.js';
import { seg } from './helpers.js';
import {
  supervisorHistory,
  agentMemoryDump,
  fullWorkflowMemory,
  memoryWithDuplicates,
} from './fixtures/orchestrator-memory.js';

const counter = new DefaultTokenCounter();

function memorySegment(id: string, data: unknown): PromptSegment {
  return seg(id, JSON.stringify(data, null, 2), 'memory');
}

function reductionPercent(original: string, compressed: string, model?: string): number {
  const before = counter.countTokens(original, model);
  const after = counter.countTokens(compressed, model);
  return ((before - after) / before) * 100;
}

describe('Integration: full pipeline', () => {
  const pipeline = createPipeline({
    stages: [createFormatStage(), createExactDedupStage(), createAllocatorStage()],
  });
  const budget: BudgetConfig = { maxTokens: 8192, outputReserve: 512 };

  it('compresses tabular supervisor history by at least 30 percent', () => {
    const original = JSON.stringify(supervisorHistory, null, 2);

    const result = pipeline.compress({ segments: [memorySegment('history', supervisorHistory)], budget });

    expect(reductionPercent(original, result.segments[0].content)).toBeGreaterThanOrEqual(30);
    expect(result.metrics.reductionPercent).toBeGreaterThan(0);
  });

  it('compresses mixed nested agent memory by at least 10 percent', () => {
    const original = JSON.stringify(agentMemoryDump, null, 2);

    const result = pipeline.compress({ segments: [memorySegment('agent-mem', agentMemoryDump)], budget });

    expect(reductionPercent(original, result.segments[0].content)).toBeGreaterThanOrEqual(10);
  });

  it('compresses blended full workflow memory by at least 15 percent', () => {
    const original = JSON.stringify(fullWorkflowMemory, null, 2);

    const result = pipeline.compress({ segments: [memorySegment('full', fullWorkflowMemory)], budget });

    expect(reductionPercent(original, result.segments[0].content)).toBeGreaterThanOrEqual(15);
  });

  it('deduplicates content shared across two segments', () => {
    const segA = seg('a', memoryWithDuplicates.agent_a_findings);
    const segB = seg('b', memoryWithDuplicates.agent_b_findings);
    const totalBefore = counter.countTokens(segA.content) + counter.countTokens(segB.content);

    const result = pipeline.compress({ segments: [segA, segB], budget });

    const totalAfter = result.segments.reduce((sum, s) => sum + counter.countTokens(s.content), 0);
    expect(totalAfter).toBeLessThan(totalBefore);
  });

  it('preserves a locked system prompt segment', () => {
    const segments = [
      seg('system', 'You are a helpful AI assistant.', 'system', { priority: 10, locked: true }),
      memorySegment('mem', fullWorkflowMemory),
    ];

    const result = pipeline.compress({ segments, budget });

    expect(result.segments[0].content).toBe('You are a helpful AI assistant.');
    expect(result.segments[0].locked).toBe(true);
  });

  it('reports one metric entry per configured stage', () => {
    const result = pipeline.compress({ segments: [memorySegment('mem', fullWorkflowMemory)], budget });

    expect(result.metrics.stages.map(s => s.name)).toEqual([
      'format-compression',
      'exact-dedup',
      'budget-allocator',
    ]);
    for (const stage of result.metrics.stages) {
      expect(stage.tokensIn).toBeGreaterThan(0);
      expect(stage.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('produces a debug source map naming the compressed keys', () => {
    const debugPipeline = createPipeline({ stages: [createFormatStage()], debug: true });

    const result = debugPipeline.compress({ segments: [memorySegment('mem', supervisorHistory)], budget });

    expect(result.sourceMap!.length).toBeGreaterThan(0);
    expect(result.sourceMap![0].original).toContain('"supervisor_id"');
    expect(result.sourceMap![0].compressed).toContain('@supervisor_id');
  });

  it('completes within 50ms on a representative payload', () => {
    const segments = [memorySegment('full', fullWorkflowMemory)];

    const start = performance.now();
    pipeline.compress({ segments, budget });
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(50);
  });

  it('counts tokens differently per model family', () => {
    const segments = [memorySegment('mem', fullWorkflowMemory)];

    const resultClaude = pipeline.compress({ segments, budget, model: 'claude-sonnet-4-6' });
    const resultGpt = pipeline.compress({ segments, budget, model: 'gpt-4o' });

    expect(resultClaude.metrics.totalTokensIn).not.toBe(resultGpt.metrics.totalTokensIn);
  });
});

describe('Integration: format compression token savings', () => {
  it('saves at least 10 percent on pretty-printed workflow memory', () => {
    const prettyJson = JSON.stringify(fullWorkflowMemory, null, 2);
    const pipeline = createPipeline({ stages: [createFormatStage()] });

    const result = pipeline.compress({
      segments: [seg('mem', prettyJson)],
      budget: { maxTokens: 10000, outputReserve: 0 },
    });

    expect(reductionPercent(prettyJson, result.segments[0].content)).toBeGreaterThanOrEqual(10);
  });
});

describe('Integration: phase 2 full pipeline', () => {
  const phase2Pipeline = createPipeline({
    stages: [
      createFormatStage(),
      createExactDedupStage(),
      createFuzzyDedupStage({ threshold: 0.8 }),
      createCotDistillationStage(),
      createHeuristicPruningStage(),
      createAllocatorStage(),
    ],
  });

  it('reduces chain-of-thought plus verbose prose by at least 35 percent', () => {
    const reasoning = '<think>Let me think about this carefully. First, I should consider the costs. Multi-agent systems are expensive. They use many tokens. The costs add up quickly. In order to reduce costs, we need optimization. Therefore: Context compression is essential.</think>';
    const verbose = 'It should be noted that in terms of the overall system architecture, the very fundamental approach to cost optimization essentially requires that we basically restructure the entire pipeline framework.';
    const content = `${reasoning}\n\n${verbose}\n\nKey finding: compression reduces costs by 40-60%.`;

    const result = phase2Pipeline.compress({
      segments: [seg('mem', content)],
      budget: { maxTokens: 100, outputReserve: 0 },
    });

    expect(reductionPercent(content, result.segments[0].content)).toBeGreaterThanOrEqual(35);
  });

  it('removes a near-duplicate that exact dedup misses while keeping unique content', () => {
    const para1 = 'Multi-agent systems cost 5-10x more than single-agent setups in production environments today';
    const para2 = 'Multi-agent systems cost 5-10x more than single-agent setups in production environments now';
    const unique = 'Local deployment improves data sovereignty and compliance.';
    const content = `${para1}\n\n${para2}\n\n${unique}`;

    const result = phase2Pipeline.compress({
      segments: [seg('mem', content)],
      budget: { maxTokens: 500, outputReserve: 0 },
    });

    expect(result.segments[0].content).toContain('sovereignty');
    expect(counter.countTokens(result.segments[0].content)).toBeLessThan(counter.countTokens(content));
  });

  it('locks system and tools segments via cache policy and compresses only memory', () => {
    const rawSegments = [
      seg('sys', 'You are a helpful assistant.', 'system', { priority: 10 }),
      seg('tools', '{"name":"save","params":{"key":"string"}}', 'tools', { priority: 8 }),
      seg('mem', JSON.stringify(fullWorkflowMemory, null, 2), 'memory', { priority: 5 }),
    ];

    const locked = applyCachePolicy(rawSegments);
    expect(locked.map(s => s.locked)).toEqual([true, true, false]);

    const result = phase2Pipeline.compress({
      segments: locked,
      budget: { maxTokens: 2000, outputReserve: 0 },
    });

    expect(result.segments[0].content).toBe('You are a helpful assistant.');
    expect(result.segments[1].content).toBe('{"name":"save","params":{"key":"string"}}');
    expect(result.segments[2].content).not.toContain('"supervisor_history"');
  });
});
