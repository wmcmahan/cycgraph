/**
 * cycgraph Adapters
 *
 * One adapter per @cycgraph/context-engine preset. Each context document
 * becomes a segment (title + text, prose role), and the preset pipeline
 * compresses to the token budget. The question is NOT fed to the pipeline
 * (query-aware compression is a separate, explicitly-labeled adapter for a
 * later phase) so these cells measure the query-agnostic presets exactly
 * as a caller would use them.
 *
 * @module bench/adapters/cycgraph
 */

import { createRequire } from 'node:module';
import {
  createOptimizedPipeline,
  createPipeline,
  createFormatStage,
  createExactDedupStage,
  createAllocatorStage,
} from '@cycgraph/context-engine';
import type { PipelinePreset, PromptSegment } from '@cycgraph/context-engine';
import type { BenchQuestion, CompressorAdapter, CompressionOutput } from '../types.js';
import { countTokens } from '../token-utils.js';

function contextEngineVersion(): string {
  // Resolved at runtime so the report always reflects the linked build.
  try {
    const req = createRequire(import.meta.url);
    const pkg = req('@cycgraph/context-engine/package.json') as { version: string };
    return pkg.version;
  } catch {
    return 'workspace';
  }
}

function toSegments(question: BenchQuestion): PromptSegment[] {
  return question.documents.map((doc, i) => ({
    id: `doc-${i}`,
    content: `${doc.title}\n${doc.text}`,
    role: 'history' as const,
    priority: 1,
  }));
}

export function createCycgraphAdapter(preset: PipelinePreset): CompressorAdapter {
  return {
    name: `cycgraph-${preset}`,
    version: contextEngineVersion(),
    async available() {
      return true;
    },
    async compress(question: BenchQuestion, budgetTokens: number): Promise<CompressionOutput> {
      const { pipeline } = createOptimizedPipeline({ preset });
      const segments = toSegments(question);

      const start = performance.now();
      const result = pipeline.compress({
        segments,
        budget: { maxTokens: budgetTokens, outputReserve: 0 },
      });
      const durationMs = performance.now() - start;

      const compressed = result.segments.map(s => s.content).join('\n\n');
      return { compressed, outputTokens: countTokens(compressed), durationMs };
    },
  };
}

/**
 * RELEVANCE-ALLOCATION variant (query-aware class): the SHIPPED `fast`
 * preset with a query — since relevance allocation became the preset
 * default, this measures exactly the production configuration an agent
 * workflow gets when the orchestrator passes the goal as the query. The
 * query decides WHICH segments get budget (whole-doc keep/drop via BM25 +
 * PRF); within-segment token selection stays entity-driven.
 *
 * Same comparison-class rules as the other `*-query-aware`-class adapters:
 * it sees the question; the plain presets don't.
 */
export function createCycgraphRelevanceAdapter(): CompressorAdapter {
  return {
    name: 'cycgraph-fast-relevance',
    version: contextEngineVersion(),
    async available() {
      return true;
    },
    async compress(question: BenchQuestion, budgetTokens: number): Promise<CompressionOutput> {
      const { pipeline } = createOptimizedPipeline({ preset: 'fast' });
      const segments = toSegments(question);

      const start = performance.now();
      const result = pipeline.compress({
        segments,
        budget: { maxTokens: budgetTokens, outputReserve: 0 },
        query: question.question,
      });
      const durationMs = performance.now() - start;

      const compressed = result.segments
        .map(s => s.content)
        .filter(c => c.trim().length > 0)
        .join('\n\n');
      return { compressed, outputTokens: countTokens(compressed), durationMs };
    },
  };
}

/**
 * TOKEN-LEVEL query-aware variant (experiment adapter): the `fast` stage
 * list with the allocator pinned to PROPORTIONAL allocation and the
 * question passed as the query — so the query influences only token-level
 * importance scoring inside the allocator's condensing path. This
 * isolates the token-granularity query effect (measured: helps at tight
 * budgets, hurts at mid budgets on multi-hop). The presets now default
 * to relevance allocation, so this adapter pins the mode explicitly to
 * keep measuring the token-level path — it is NOT the shipped config.
 *
 * This adapter is in a different comparison class from the query-agnostic
 * adapters above — it sees information they don't. Never present its row
 * as the same product configuration as the plain presets without labeling.
 */
export function createCycgraphQueryAwareAdapter(_preset: PipelinePreset = 'fast'): CompressorAdapter {
  return {
    name: 'cycgraph-fast-query-aware',
    version: contextEngineVersion(),
    async available() {
      return true;
    },
    async compress(question: BenchQuestion, budgetTokens: number): Promise<CompressionOutput> {
      // fast preset's stage list, allocator pinned to proportional
      const pipeline = createPipeline({
        stages: [
          createFormatStage(),
          createExactDedupStage(),
          createAllocatorStage({ allocation: 'proportional' }),
        ],
      });
      const segments = toSegments(question);

      const start = performance.now();
      const result = pipeline.compress({
        segments,
        budget: { maxTokens: budgetTokens, outputReserve: 0 },
        query: question.question,
      });
      const durationMs = performance.now() - start;

      const compressed = result.segments.map(s => s.content).join('\n\n');
      return { compressed, outputTokens: countTokens(compressed), durationMs };
    },
  };
}
