import { describe, it, expect } from 'vitest';
import { runBench, formatMarkdownReport } from '../../src/bench/runner.js';
import { SMOKE_QUESTIONS } from '../../src/bench/dataset/hotpotqa.js';
import type { BenchConfig } from '../../src/bench/types.js';
import type { EvalProvider } from '../../src/providers/types.js';

/**
 * Oracle reader: answers correctly IFF the answer text survives in the
 * compressed context. Lets us test the full pipeline offline — a compressor
 * that keeps the answer scores 1.0, one that drops it scores 0.
 */
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

describe('runBench', () => {
  it('produces a ceiling cell plus one cell per adapter x ratio', async () => {
    const report = await runBench({
      config,
      questions: SMOKE_QUESTIONS,
      subsetHash: 'test',
      reader: createOracleReader(),
      readerModel: 'oracle',
    });

    // none + 2 non-ceiling adapters x 1 ratio
    expect(report.cells.length).toBe(3);
    expect(report.cells[0].adapter).toBe('none');
    expect(report.cells[0].ratio).toBe(1.0);

    // Ceiling: oracle always finds the answer in the full context
    expect(report.cells[0].meanF1).toBe(1);
    expect(report.cells[0].meanExactMatch).toBe(1);

    // Every cell carries per-question raw results for re-analysis
    for (const cell of report.cells) {
      expect(cell.questions.length).toBe(SMOKE_QUESTIONS.length);
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

    for (const cell of report.cells) {
      if (cell.adapter === 'none') continue;
      // delta = meanF1(cell) - meanF1(ceiling); ceiling is 1.0 here
      expect(cell.f1DeltaVsNone).toBeCloseTo(cell.meanF1 - 1, 10);
      // Achieved ratio is measured, not assumed
      expect(cell.achievedRatio).toBeGreaterThan(0);
      expect(cell.achievedRatio).toBeLessThan(1);
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

    for (const q of baseline.questions) {
      const refTokens = reference.questions.find(r => r.questionId === q.questionId)!.outputTokens;
      // Truncation fills its budget to the cap — which IS the reference's achieved count.
      expect(q.outputTokens).toBeLessThanOrEqual(refTokens);
      expect(q.outputTokens).toBeGreaterThan(refTokens * 0.7); // and not wildly under
    }
    // Cells now sit at (approximately) identical achieved compression
    expect(Math.abs(baseline.achievedRatio - reference.achievedRatio)).toBeLessThan(0.1);
  });

  it('rejects a budgetReference that is not in the adapter list', async () => {
    await expect(
      runBench({
        config: { ...config, budgetReference: 'llmlingua-2' },
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

    // One checkpoint per cell, strictly growing
    expect(checkpoints).toEqual([1, 2, 3]);

    // Resume with all cells completed: the reader must never be called
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
