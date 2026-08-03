/**
 * Report generator tests — synthetic artifacts with known statistics, so
 * every assertion pins a number the generator must compute (not copy). The
 * edge-case reports drive the negative-result, minimal-provenance,
 * missing-cell, and absent-adapter branches. The CLI `main()` is argv/fs
 * driver code and is left uncovered by design.
 */

import { describe, expect, it } from 'vitest';
import { generateBenchmarksMarkdown, SOLVABLE_F1 } from '../../src/bench/report-generator.js';
import type { BenchReport, CellResult, QuestionResult } from '../../src/bench/types.js';

function q(id: string, f1: number, tokens = 100): QuestionResult {
  return { questionId: id, exactMatch: f1 === 1 ? 1 : 0, f1, outputTokens: tokens, compressionMs: 5 };
}

function cell(
  adapter: string,
  ratio: number,
  questions: QuestionResult[],
  deltas: { f1DeltaVsNone?: number; f1DeltaCi95?: number } = {},
): CellResult {
  return {
    adapter,
    ratio,
    achievedRatio: ratio,
    meanExactMatch: 0,
    meanF1: questions.reduce((s, x) => s + x.f1, 0) / questions.length,
    f1DeltaVsNone: deltas.f1DeltaVsNone ?? -0.1,
    f1DeltaCi95: deltas.f1DeltaCi95 ?? 0.05,
    meanCompressionMs: 5,
    questions,
  };
}

function makeReport(): BenchReport {
  const ceiling = [q('2hop__a', 1), q('2hop__b', 0.8), q('3hop__c', 0.6), q('3hop__d', 0.2)];
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
    expect(md).toContain('+0.525');
    expect(md).toContain('significant win');
  });

  it('computes solvable retention from the ceiling', () => {
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
    expect(md).toContain('`cafebabecafebabe…`');
    expect(md).toContain('abc123');
    expect(md).toContain('llmlingua-2@0.2.2');
  });

  it('auto-reports the ceiling cost as a negative result', () => {
    expect(md).toContain('compression is not free');
  });

  it('includes a reproduction command for the dataset config', () => {
    expect(md).toContain('--config bench.musique.config.json');
  });
});

describe('generateBenchmarksMarkdown — minimal-provenance loss report', () => {
  function makeLossReport(): BenchReport {
    const ceiling = [q('q1', 1), q('q2', 0.8), q('q3', 0.6), q('q4', 0.2)];
    const headline = [q('q1', 0.1), q('q2', 0.1), q('q3', 0.1), q('q4', 0.1)];
    const llmlingua = [q('q1', 0.9), q('q2', 0.9), q('q3', 0.9), q('q4', 0.9)];
    const truncation = [q('q1', 0.1), q('q2', 0.1), q('q3', 0.1), q('q4', 0.1)];
    return {
      config: {
        dataset: 'hotpotqa-dev',
        datasetUrl: 'https://example.test/hotpot.json',
        subsetSize: 4,
        seed: 1,
        ratios: [0.3],
        adapters: ['none', 'cycgraph-fast-relevance', 'truncation-tail', 'llmlingua-2'],
      },
      configHash: '0'.repeat(64),
      subsetHash: '1'.repeat(64),
      readerModel: 'test-reader',
      startedAt: '2026-07-17T00:00:00.000Z',
      cells: [
        cell('none', 1.0, ceiling),
        cell('cycgraph-fast-relevance', 0.3, headline, { f1DeltaVsNone: 0, f1DeltaCi95: 0.2 }),
        cell('truncation-tail', 0.3, truncation),
        cell('llmlingua-2', 0.3, llmlingua),
      ],
      skippedAdapters: [],
    };
  }

  const md = generateBenchmarksMarkdown([
    { report: makeLossReport(), artifactName: 'loss.json' },
  ]);

  it('marks a significant loss and an indistinguishable tie in the head-to-head', () => {
    expect(md).toContain('significant loss');
    expect(md).toContain('indistinguishable');
  });

  it('lists both the loss and the tie in negative results', () => {
    expect(md).toContain('`cycgraph-fast-relevance` loses to `llmlingua-2`');
    expect(md).toContain('`cycgraph-fast-relevance` indistinguishable from `truncation-tail`');
  });

  it('omits the hop breakdown for ids without a hop prefix', () => {
    expect(md).not.toContain('Retention by hop count');
  });

  it('falls back to the target-ratio provenance note and the default reproduction command', () => {
    expect(md).toContain('target-ratio caps');
    expect(md).toContain('npm run bench');
    expect(md).not.toContain('raw dataset sha256');
    expect(md).not.toContain('engine versions');
  });
});

describe('generateBenchmarksMarkdown — clean-win report', () => {
  function makeWinReport(): BenchReport {
    const ceiling = [q('q1', 1), q('q2', 1)];
    const headline = [q('q1', 1), q('q2', 1)];
    const weak = [q('q1', 0.1), q('q2', 0.1)];
    return {
      config: {
        dataset: 'hotpotqa-dev',
        datasetUrl: 'https://example.test/hotpot.json',
        subsetSize: 2,
        seed: 1,
        ratios: [0.3],
        adapters: ['none', 'cycgraph-fast-relevance', 'truncation-tail', 'llmlingua-2'],
      },
      configHash: '0'.repeat(64),
      subsetHash: '1'.repeat(64),
      readerModel: 'test-reader',
      startedAt: '2026-07-17T00:00:00.000Z',
      cells: [
        cell('none', 1.0, ceiling),
        cell('cycgraph-fast-relevance', 0.3, headline, { f1DeltaVsNone: 0, f1DeltaCi95: 0.2 }),
        cell('truncation-tail', 0.3, weak),
        cell('llmlingua-2', 0.3, weak),
      ],
      skippedAdapters: [],
    };
  }

  it('reports no negatives when the headline wins everywhere at no cost', () => {
    const md = generateBenchmarksMarkdown([
      { report: makeWinReport(), artifactName: 'win.json' },
    ]);

    expect(md).toContain('None detected in these artifacts.');
  });
});

describe('generateBenchmarksMarkdown — missing cells and absent headline', () => {
  it('renders em dashes for a competitor missing at some ratios', () => {
    const ceiling = [q('2hop__a', 1), q('2hop__b', 0.8)];
    const headline03 = [q('2hop__a', 0.9), q('2hop__b', 0.7)];
    const headline05 = [q('2hop__a', 0.95), q('2hop__b', 0.75)];
    const llmlingua03 = [q('2hop__a', 0.2), q('2hop__b', 0.1)];
    const report: BenchReport = {
      config: {
        dataset: 'musique-ans-dev',
        datasetUrl: 'https://example.test/musique.jsonl',
        subsetSize: 2,
        seed: 1,
        ratios: [0.3, 0.5],
        adapters: ['none', 'cycgraph-fast-relevance', 'llmlingua-2'],
      },
      configHash: '0'.repeat(64),
      subsetHash: '1'.repeat(64),
      readerModel: 'test-reader',
      startedAt: '2026-07-17T00:00:00.000Z',
      cells: [
        cell('none', 1.0, ceiling),
        cell('cycgraph-fast-relevance', 0.3, headline03),
        cell('cycgraph-fast-relevance', 0.5, headline05),
        cell('llmlingua-2', 0.3, llmlingua03),
      ],
      skippedAdapters: [],
    };

    const md = generateBenchmarksMarkdown([{ report, artifactName: 'partial.json' }]);

    expect(md).toContain('| llmlingua-2 |');
    expect(md).toContain('—');
  });

  it('counts a solvable question an adapter never scored as not retained', () => {
    const ceiling = [q('q1', 1), q('q2', 0.9)];
    const headline = [q('q1', 0.9)];
    const report: BenchReport = {
      config: {
        dataset: 'hotpotqa-dev',
        datasetUrl: 'https://example.test/hotpot.json',
        subsetSize: 2,
        seed: 1,
        ratios: [0.3],
        adapters: ['none', 'cycgraph-fast-relevance'],
      },
      configHash: '0'.repeat(64),
      subsetHash: '1'.repeat(64),
      readerModel: 'test-reader',
      startedAt: '2026-07-17T00:00:00.000Z',
      cells: [
        cell('none', 1.0, ceiling),
        cell('cycgraph-fast-relevance', 0.3, headline),
      ],
      skippedAdapters: [],
    };

    const md = generateBenchmarksMarkdown([{ report, artifactName: 'partial-ids.json' }]);

    expect(md).toContain('| cycgraph-fast-relevance | 1/2 |');
  });

  it('emits the absent-adapters note when the headline is not in the run', () => {
    const ceiling = [q('q1', 1), q('q2', 0.8)];
    const report: BenchReport = {
      config: {
        dataset: 'hotpotqa-dev',
        datasetUrl: 'https://example.test/hotpot.json',
        subsetSize: 2,
        seed: 1,
        ratios: [0.3],
        adapters: ['none', 'llmlingua-2'],
      },
      configHash: '0'.repeat(64),
      subsetHash: '1'.repeat(64),
      readerModel: 'test-reader',
      startedAt: '2026-07-17T00:00:00.000Z',
      cells: [
        cell('none', 1.0, ceiling),
        cell('llmlingua-2', 0.3, [q('q1', 0.5), q('q2', 0.4)]),
      ],
      skippedAdapters: [],
    };

    const md = generateBenchmarksMarkdown([{ report, artifactName: 'no-headline.json' }]);

    expect(md).toContain('Headline adapter or comparison adapters absent from this run.');
  });
});
