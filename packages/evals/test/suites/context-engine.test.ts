import { describe, it, expect } from 'vitest';
import { runDeterministic } from '../../src/suites/context-engine/suite.js';

describe('context-engine deterministic suite', () => {
  it('runs all deterministic test cases (Phase 1-4 + efficacy frontier)', async () => {
    const results = await runDeterministic();
    // 18 Phase 1-4 cases + 6 efficacy frontier cells (2 scenarios x 3 presets)
    expect(results.length).toBe(24);
  });

  it('all tests pass on known-good inputs', async () => {
    const results = await runDeterministic();

    for (const testCase of results) {
      expect(testCase.suite).toBe('context-engine');

      for (const det of testCase.deterministicResults ?? []) {
        expect(det.passed, `Failed: ${det.metric} — ${det.description}`).toBe(true);
      }
    }
  });

  it('reports correct metrics for tabular compression', async () => {
    const results = await runDeterministic();
    const tabular = results.find(r =>
      r.deterministicResults?.some(d => d.metric === 'tabular_compression'),
    );
    expect(tabular).toBeDefined();

    const det = tabular!.deterministicResults!.find(d => d.metric === 'tabular_compression')!;
    expect(det.passed).toBe(true);
    expect(det.actual).toBeGreaterThanOrEqual(30);
  });

  it('reports correct metrics for budget compliance', async () => {
    const results = await runDeterministic();
    const budget = results.find(r =>
      r.deterministicResults?.some(d => d.metric === 'budget_compliance'),
    );
    expect(budget).toBeDefined();

    const det = budget!.deterministicResults!.find(d => d.metric === 'budget_compliance')!;
    expect(det.passed).toBe(true);
    expect(det.actual).toBeLessThanOrEqual(det.expected);
  });

  it('reports correct dedup counts', async () => {
    const results = await runDeterministic();
    const dedupTest = results.find(r =>
      r.deterministicResults?.some(d => d.metric === 'dedup_removed'),
    );
    expect(dedupTest).toBeDefined();

    const removed = dedupTest!.deterministicResults!.find(d => d.metric === 'dedup_removed')!;
    expect(removed.actual).toBe(1);

    const unique = dedupTest!.deterministicResults!.find(d => d.metric === 'dedup_unique')!;
    expect(unique.actual).toBe(2);
  });

  it('format serialization is stable across runs', async () => {
    const results = await runDeterministic();
    const stability = results.find(r =>
      r.deterministicResults?.some(d => d.metric === 'format_stability'),
    );
    expect(stability).toBeDefined();

    const det = stability!.deterministicResults!.find(d => d.metric === 'format_stability')!;
    expect(det.passed).toBe(true);
  });
});
