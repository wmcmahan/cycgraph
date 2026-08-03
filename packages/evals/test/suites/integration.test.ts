import { describe, it, expect } from 'vitest';
import { runDeterministic } from '../../src/suites/integration/suite.js';

describe('integration deterministic suite', () => {
  it('integration suite module loads successfully', async () => {
    const module = await import('../../src/suites/integration/suite.js');
    expect(module.runDeterministic).toBeDefined();
    expect(module.buildSutSuite).toBeDefined();
  });

  it('runDeterministic() returns results array', async () => {
    const results = await runDeterministic();
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);
  });

  it('all deterministic test cases pass', async () => {
    const results = await runDeterministic();

    for (const testCase of results) {
      for (const det of testCase.deterministicResults ?? []) {
        expect(det.passed, `Failed: ${det.metric} — ${det.description}`).toBe(true);
      }
    }
  });

  it('results have correct suite name', async () => {
    const results = await runDeterministic();

    for (const testCase of results) {
      expect(testCase.suite).toBe('integration');
    }
  });

  it('result count matches expected test case count', async () => {
    const results = await runDeterministic();
    expect(results.length).toBe(10);
  });
});
