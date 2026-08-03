/**
 * Benchmark runner tests. An oracle reader (answers iff the gold survives
 * in the compressed context) drives the full pipeline offline; a mocked
 * llmlingua adapter (unavailable) exercises the skip-and-report path
 * deterministically. `main()` is CLI/argv/network driver code and is left
 * uncovered by design.
 */

import { describe, it, expect, vi } from 'vitest';
import { runBench, formatMarkdownReport } from '../../src/bench/runner.js';
import { SMOKE_QUESTIONS } from '../../src/bench/dataset/hotpotqa.js';
import type { BenchConfig, BenchReport, CellResult, QuestionResult } from '../../src/bench/types.js';
import type { EvalProvider } from '../../src/providers/types.js';

vi.mock('../../src/bench/adapters/llmlingua.js', () => ({
  llmlinguaAdapter: {
    name: 'llmlingua-2',
    version: 'mock',
    available: async () => false,
    compress: async () => ({ compressed: '', outputTokens: 0, durationMs: 0 }),
  },
  stopLlmlinguaBridge: () => {},
}));

function createOracleReader(): EvalProvider {
  return {
    name: 'oracle-reader',
    mode: 'local',
    maxConcurrency: 1,
    async callJudge(prompt: string): Promise<string> {
      const questionMatch = prompt.match(/Question: (.*)\n/);
      const question = SMOKE_QUESTIONS.find(q => q.question === questionMatch?.[1]);
      if (!question) return 'unknown';
      const context = prompt.slice(prompt.indexOf('Context:'), prompt.indexOf('Question:'));
      return context.includes(question.answer) ? question.answer : 'unknown';
    },
    estimateCost: () => ({ estimatedUsd: 0 }),
  };
}

const config: BenchConfig = {
  dataset: 'smoke',
  datasetUrl: 'bundled',
  subsetSize: SMOKE_QUESTIONS.length,
  seed: 1,
  ratios: [0.5],
  adapters: ['none', 'truncation-tail', 'cycgraph-balanced'],
};

function q(id: string, tokens = 100): QuestionResult {
  return { questionId: id, exactMatch: 1, f1: 1, outputTokens: tokens, compressionMs: 5 };
}

function cell(adapter: string, ratio: number): CellResult {
  return {
    adapter,
    ratio,
    achievedRatio: ratio,
    meanExactMatch: 1,
    meanF1: 1,
    f1DeltaVsNone: -0.05,
    f1DeltaCi95: 0.02,
    meanCompressionMs: 5,
    questions: [q('smoke-1')],
  };
}

describe('runBench', () => {
  it('produces a ceiling cell plus one cell per adapter x ratio', async () => {
    const report = await runBench({
      config,
      questions: SMOKE_QUESTIONS,
      subsetHash: 'test',
      reader: createOracleReader(),
      readerModel: 'oracle',
    });

    expect(report.cells.length).toBe(3);
    expect(report.cells[0].adapter).toBe('none');
    expect(report.cells[0].ratio).toBe(1.0);
    expect(report.cells[0].meanF1).toBe(1);
    expect(report.cells[0].meanExactMatch).toBe(1);

    for (const c of report.cells) {
      expect(c.questions.length).toBe(SMOKE_QUESTIONS.length);
    }
  });

  it('computes paired deltas against the ceiling', async () => {
    const report = await runBench({
      config,
      questions: SMOKE_QUESTIONS,
      subsetHash: 'test',
      reader: createOracleReader(),
      readerModel: 'oracle',
    });

    for (const c of report.cells) {
      if (c.adapter === 'none') continue;
      expect(c.f1DeltaVsNone).toBeCloseTo(c.meanF1 - 1, 10);
      expect(c.achievedRatio).toBeGreaterThan(0);
      expect(c.achievedRatio).toBeLessThan(1);
    }
  });

  it('throws on unknown adapter names instead of silently skipping', async () => {
    await expect(
      runBench({
        config: { ...config, adapters: ['none', 'not-a-real-engine'] },
        questions: SMOKE_QUESTIONS,
        subsetHash: 'test',
        reader: createOracleReader(),
        readerModel: 'oracle',
      }),
    ).rejects.toThrow(/Unknown adapters/);
  });

  it('skips adapters that report unavailable and records them', async () => {
    const logs: string[] = [];
    const report = await runBench({
      config: { ...config, adapters: ['none', 'truncation-tail', 'llmlingua-2'] },
      questions: SMOKE_QUESTIONS,
      subsetHash: 'test',
      reader: createOracleReader(),
      readerModel: 'oracle',
      log: m => logs.push(m),
    });

    expect(report.skippedAdapters).toContain('llmlingua-2');
    expect(report.cells.some(c => c.adapter === 'llmlingua-2')).toBe(false);
    expect(logs.some(m => m.includes('skipped (unavailable): llmlingua-2'))).toBe(true);
  });

  it('throws when the budgetReference adapter is unavailable in the environment', async () => {
    await expect(
      runBench({
        config: { ...config, adapters: ['none', 'llmlingua-2'], budgetReference: 'llmlingua-2' },
        questions: SMOKE_QUESTIONS,
        subsetHash: 'test',
        reader: createOracleReader(),
        readerModel: 'oracle',
      }),
    ).rejects.toThrow(/unavailable in this environment/);
  });

  it('matched-budget mode hands baselines the reference adapter achieved tokens', async () => {
    const matched: BenchConfig = {
      ...config,
      adapters: ['none', 'cycgraph-balanced', 'truncation-tail'],
      budgetReference: 'cycgraph-balanced',
    };
    const report = await runBench({
      config: matched,
      questions: SMOKE_QUESTIONS,
      subsetHash: 'test',
      reader: createOracleReader(),
      readerModel: 'oracle',
    });

    const reference = report.cells.find(c => c.adapter === 'cycgraph-balanced' && c.ratio === 0.5)!;
    const baseline = report.cells.find(c => c.adapter === 'truncation-tail' && c.ratio === 0.5)!;

    for (const question of baseline.questions) {
      const refTokens = reference.questions.find(r => r.questionId === question.questionId)!.outputTokens;
      expect(question.outputTokens).toBeLessThanOrEqual(refTokens);
      expect(question.outputTokens).toBeGreaterThan(refTokens * 0.7);
    }
    expect(Math.abs(baseline.achievedRatio - reference.achievedRatio)).toBeLessThan(0.1);
  });

  it('rejects a budgetReference that is not in the adapter list', async () => {
    await expect(
      runBench({
        config: { ...config, budgetReference: 'cycgraph-maximum' },
        questions: SMOKE_QUESTIONS,
        subsetHash: 'test',
        reader: createOracleReader(),
        readerModel: 'oracle',
      }),
    ).rejects.toThrow(/not in config.adapters/);
  });

  it('checkpoints after every cell and resumes without re-running completed cells', async () => {
    const checkpoints: number[] = [];
    const first = await runBench({
      config,
      questions: SMOKE_QUESTIONS,
      subsetHash: 'test',
      reader: createOracleReader(),
      readerModel: 'oracle',
      onCellComplete: (_cell, cellsSoFar) => checkpoints.push(cellsSoFar.length),
    });

    expect(checkpoints).toEqual([1, 2, 3]);

    let readerCalls = 0;
    const countingReader: EvalProvider = {
      ...createOracleReader(),
      async callJudge(prompt: string) {
        readerCalls++;
        return createOracleReader().callJudge(prompt);
      },
    };
    const resumed = await runBench({
      config,
      questions: SMOKE_QUESTIONS,
      subsetHash: 'test',
      reader: countingReader,
      readerModel: 'oracle',
      completedCells: first.cells,
    });

    expect(readerCalls).toBe(0);
    expect(resumed.cells.length).toBe(first.cells.length);
    expect(resumed.cells.map(c => `${c.adapter}|${c.ratio}`).sort())
      .toEqual(first.cells.map(c => `${c.adapter}|${c.ratio}`).sort());
  });

  it('reuses the reference cell on a matched-budget resume', async () => {
    const matched: BenchConfig = {
      ...config,
      adapters: ['none', 'cycgraph-balanced', 'truncation-tail'],
      budgetReference: 'cycgraph-balanced',
    };
    const first = await runBench({
      config: matched,
      questions: SMOKE_QUESTIONS,
      subsetHash: 'test',
      reader: createOracleReader(),
      readerModel: 'oracle',
    });

    const logs: string[] = [];
    const resumed = await runBench({
      config: matched,
      questions: SMOKE_QUESTIONS,
      subsetHash: 'test',
      reader: createOracleReader(),
      readerModel: 'oracle',
      completedCells: first.cells,
      log: m => logs.push(m),
    });

    expect(logs.some(m => m.includes('cycgraph-balanced @ ratio 0.5 (reference, resumed)'))).toBe(true);
    expect(resumed.cells.length).toBe(first.cells.length);
  });

  it('embeds config hash and formats a markdown table', async () => {
    const report = await runBench({
      config,
      questions: SMOKE_QUESTIONS,
      subsetHash: 'abc123',
      reader: createOracleReader(),
      readerModel: 'oracle',
    });

    expect(report.configHash).toMatch(/^[a-f0-9]{64}$/);

    const md = formatMarkdownReport(report);
    expect(md).toContain('| adapter | target ratio |');
    expect(md).toContain('truncation-tail');
    expect(md).toContain('cycgraph-balanced');
    expect(md).toContain('ΔF1 vs none');
  });
});

describe('formatMarkdownReport', () => {
  function report(overrides: Partial<BenchReport>): BenchReport {
    return {
      config,
      configHash: 'a'.repeat(64),
      subsetHash: 'b'.repeat(64),
      readerModel: 'oracle',
      startedAt: '2026-07-17T00:00:00.000Z',
      cells: [cell('none', 1.0), cell('truncation-tail', 0.5)],
      skippedAdapters: [],
      ...overrides,
    };
  }

  it('describes matched budgets when a budgetReference is set', () => {
    const md = formatMarkdownReport(report({
      config: { ...config, budgetReference: 'cycgraph-balanced' },
    }));

    expect(md).toContain('budgets: matched to **cycgraph-balanced**');
  });

  it('describes target-ratio caps when no budgetReference is set', () => {
    const md = formatMarkdownReport(report({}));

    expect(md).toContain('budgets: target-ratio caps');
  });

  it('lists skipped adapters when present', () => {
    const md = formatMarkdownReport(report({ skippedAdapters: ['llmlingua-2'] }));

    expect(md).toContain('skipped (unavailable): llmlingua-2');
  });

  it('renders an em dash for the ceiling delta and a signed delta for others', () => {
    const md = formatMarkdownReport(report({}));

    expect(md).toContain('| none | 1.00 | 1.00 | 1.000 | 1.000 | — |');
    expect(md).toContain('-0.050 (±0.020)');
  });

  it('reports zero questions when the run produced no cells', () => {
    const md = formatMarkdownReport(report({ cells: [] }));

    expect(md).toContain('questions: 0');
  });
});
