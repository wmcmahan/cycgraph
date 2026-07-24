/**
 * Report generator tests — synthetic artifacts with known statistics, so
 * every assertion pins a number the generator must compute (not copy).
 */

import { describe, expect, it } from 'vitest';
import { generateBenchmarksMarkdown, SOLVABLE_F1 } from '../../src/bench/report-generator.js';
import type { BenchReport, CellResult, QuestionResult } from '../../src/bench/types.js';

function q(id: string, f1: number, tokens = 100): QuestionResult {
  return { questionId: id, exactMatch: f1 === 1 ? 1 : 0, f1, outputTokens: tokens, compressionMs: 5 };
}

function cell(adapter: string, ratio: number, questions: QuestionResult[]): CellResult {
  return {
    adapter,
    ratio,
    achievedRatio: ratio,
    meanExactMatch: 0,
    meanF1: questions.reduce((s, x) => s + x.f1, 0) / questions.length,
    f1DeltaVsNone: -0.1,
    f1DeltaCi95: 0.05,
    meanCompressionMs: 5,
    questions,
  };
}

function makeReport(): BenchReport {
  // 4 questions; ids carry MuSiQue hop prefixes. Ceiling: q1-q3 solvable.
  const ceiling = [q('2hop__a', 1), q('2hop__b', 0.8), q('3hop__c', 0.6), q('3hop__d', 0.2)];
  // Headline wins every solvable question vs llmlingua at 0.3.
  const relevance = [q('2hop__a', 1), q('2hop__b', 0.8), q('3hop__c', 0.6), q('3hop__d', 0)];
  const llmlingua = [q('2hop__a', 0.2), q('2hop__b', 0.1), q('3hop__c', 0), q('3hop__d', 0)];
  return {
    config: {
      dataset: 'musique-ans-dev',
      datasetUrl: 'https://example.test/musique.jsonl',
      datasetSha256: 'abc123',
      subsetSize: 4,
      seed: 42,
      ratios: [0.3],
      adapters: ['none', 'cycgraph-fast-relevance', 'llmlingua-2'],
      budgetReference: 'cycgraph-fast-relevance',
    },
    configHash: 'deadbeef'.repeat(8),
    subsetHash: 'cafebabe'.repeat(8),
    readerModel: 'test-reader',
    startedAt: '2026-07-17T00:00:00.000Z',
    cells: [
      cell('none', 1.0, ceiling),
      cell('cycgraph-fast-relevance', 0.3, relevance),
      cell('llmlingua-2', 0.3, llmlingua),
    ],
    skippedAdapters: ['truncation-head'],
    adapterVersions: { 'cycgraph-fast-relevance': '1.2.3', 'llmlingua-2': '0.2.2' },
  };
}

describe('generateBenchmarksMarkdown', () => {
  const md = generateBenchmarksMarkdown([
    { report: makeReport(), artifactName: 'bench-test.json' },
  ]);

  it('is deterministic', () => {
    const again = generateBenchmarksMarkdown([
      { report: makeReport(), artifactName: 'bench-test.json' },
    ]);
    expect(again).toBe(md);
  });

  it('computes the paired head-to-head from per-question data', () => {
    // deltas vs llmlingua: 0.8, 0.7, 0.6, 0 → mean 0.525
    expect(md).toContain('+0.525');
    expect(md).toContain('significant win');
  });

  it('computes solvable retention from the ceiling', () => {
    // 3 of 4 solvable at ceiling; relevance keeps all 3, llmlingua 0
    expect(md).toContain(`ceiling F1 ≥ ${SOLVABLE_F1}`);
    expect(md).toContain('| cycgraph-fast-relevance | 3/3 |');
    expect(md).toContain('| llmlingua-2 | 0/3 |');
  });

  it('emits the per-hop breakdown for MuSiQue ids', () => {
    expect(md).toContain('Retention by hop count');
    expect(md).toContain('| 2hop | 2 |');
    expect(md).toContain('| 3hop | 1 |');
  });

  it('reports skipped adapters and full provenance', () => {
    expect(md).toContain('skipped (unavailable in the run environment): truncation-head');
    expect(md).toContain('`cafebabecafebabe…`'); // subset hash
    expect(md).toContain('abc123'); // dataset content hash
    expect(md).toContain('llmlingua-2@0.2.2');
  });

  it('auto-reports the ceiling cost as a negative result', () => {
    // f1DeltaVsNone -0.1 ± 0.05 is a significant cost
    expect(md).toContain('compression is not free');
  });

  it('includes a reproduction command for the dataset config', () => {
    expect(md).toContain('--config bench.musique.config.json');
  });
});
