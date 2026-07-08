import { describe, it, expect } from 'vitest';
import { computeDrift } from '../../src/assertions/drift-calculator.js';
import type { TestCaseResults } from '../../src/assertions/drift-calculator.js';

function makeResult(
  suite: string,
  zodPassed: boolean,
  semanticPassed: boolean,
): TestCaseResults {
  return {
    suite,
    zodResults: [{
      passed: zodPassed,
      toolName: 'test_tool',
      missingParams: zodPassed ? [] : ['param'],
      typeMismatches: [],
    }],
    semanticResults: [{
      passed: semanticPassed,
      score: semanticPassed ? 0.9 : 0.5,
      reasoning: 'test',
      metric: 'answer_relevancy',
    }],
  };
}

describe('computeDrift', () => {
  describe('aggregate calculation', () => {
    it('returns 0% drift when all tests pass', () => {
      const results = [
        makeResult('orchestrator', true, true),
        makeResult('orchestrator', true, true),
        makeResult('orchestrator', true, true),
      ];

      const report = computeDrift(results);

      expect(report.aggregatePercent).toBe(0);
      expect(report.passed).toBe(true);
    });

    it('computes correct drift percentage', () => {
      const results = [
        makeResult('orchestrator', true, true),
        makeResult('orchestrator', false, true),  // 1 zod failure
        makeResult('orchestrator', true, true),
        makeResult('orchestrator', true, true),
      ];

      const report = computeDrift(results);

      // 1 failure / 4 tests = 25%
      expect(report.aggregatePercent).toBe(25);
      expect(report.passed).toBe(false);
    });

    it('counts a test that fails multiple categories only ONCE', () => {
      const results = [
        makeResult('orchestrator', false, false), // fails zod AND semantic → 1 drifted test
        makeResult('orchestrator', true, true),
      ];

      const report = computeDrift(results);

      // 1 drifted test / 2 tests = 50% (NOT 100% — drift is a fraction of tests,
      // not a sum of failure events across categories).
      expect(report.aggregatePercent).toBe(50);
      expect(report.perSuite['orchestrator'].driftedTests).toBe(1);
      expect(report.passed).toBe(false);
    });

    it('returns 100% when all tests fail', () => {
      const results = [
        makeResult('orchestrator', false, false),
        makeResult('orchestrator', false, false),
      ];

      const report = computeDrift(results);

      // 2 drifted / 2 tests = 100% — never exceeds 100.
      expect(report.aggregatePercent).toBe(100);
      expect(report.passed).toBe(false);
    });
  });

  describe('per-suite breakdown', () => {
    it('groups results by suite', () => {
      const results = [
        makeResult('orchestrator', true, true),
        makeResult('orchestrator', false, true),
        makeResult('context-engine', true, false),
      ];

      const report = computeDrift(results);

      expect(report.perSuite['orchestrator'].totalTests).toBe(2);
      expect(report.perSuite['orchestrator'].zodFailures).toBe(1);
      expect(report.perSuite['orchestrator'].semanticFailures).toBe(0);
      expect(report.perSuite['orchestrator'].driftPercent).toBe(50);

      expect(report.perSuite['context-engine'].totalTests).toBe(1);
      expect(report.perSuite['context-engine'].zodFailures).toBe(0);
      expect(report.perSuite['context-engine'].semanticFailures).toBe(1);
      expect(report.perSuite['context-engine'].driftPercent).toBe(100);
    });
  });

  describe('drift ceiling gate', () => {
    it('passes when drift is below ceiling', () => {
      const results = [
        makeResult('orchestrator', true, true),
        makeResult('orchestrator', true, true),
        makeResult('orchestrator', true, true),
        makeResult('orchestrator', true, true),
        makeResult('orchestrator', true, true),
        makeResult('orchestrator', true, true),
        makeResult('orchestrator', true, true),
        makeResult('orchestrator', true, true),
        makeResult('orchestrator', true, true),
        makeResult('orchestrator', true, true),
        makeResult('orchestrator', true, true),
        makeResult('orchestrator', true, true),
        makeResult('orchestrator', true, true),
        makeResult('orchestrator', true, true),
        makeResult('orchestrator', true, true),
        makeResult('orchestrator', true, true),
        makeResult('orchestrator', true, true),
        makeResult('orchestrator', true, true),
        makeResult('orchestrator', true, true),
        makeResult('orchestrator', false, true),  // 1 of 20 = 5%
      ];

      // Default ceiling is 5.0 — exactly 5% fails (< not <=)
      const report = computeDrift(results);
      expect(report.aggregatePercent).toBe(5);
      expect(report.passed).toBe(false);
    });

    it('respects custom drift ceiling', () => {
      const results = [
        makeResult('orchestrator', true, true),
        makeResult('orchestrator', false, true),  // 1 of 2 = 50%
      ];

      const lenient = computeDrift(results, 60.0);
      expect(lenient.passed).toBe(true);

      const strict = computeDrift(results, 10.0);
      expect(strict.passed).toBe(false);
    });
  });

  describe('deterministic results', () => {
    it('counts deterministic failures in drift', () => {
      const results: TestCaseResults[] = [
        {
          suite: 'context-engine',
          zodResults: [],
          semanticResults: [],
          deterministicResults: [
            { passed: false, metric: 'compression_ratio', expected: 30, actual: 15, description: 'too low' },
          ],
        },
        {
          suite: 'context-engine',
          zodResults: [],
          semanticResults: [],
          deterministicResults: [
            { passed: true, metric: 'budget_compliance', expected: 4096, actual: 3500, description: 'ok' },
          ],
        },
      ];

      const report = computeDrift(results);

      expect(report.perSuite['context-engine'].deterministicFailures).toBe(1);
      expect(report.perSuite['context-engine'].totalTests).toBe(2);
      expect(report.perSuite['context-engine'].driftPercent).toBe(50);
    });

    it('does not count deterministic results when absent (backward compat)', () => {
      const results: TestCaseResults[] = [
        makeResult('orchestrator', true, true),
      ];

      const report = computeDrift(results);

      expect(report.perSuite['orchestrator'].deterministicFailures).toBe(0);
      expect(report.perSuite['orchestrator'].driftPercent).toBe(0);
    });

    it('combines all three failure types in drift calculation', () => {
      const results: TestCaseResults[] = [
        {
          suite: 'context-engine',
          zodResults: [{ passed: false, toolName: 'test', missingParams: ['a'], typeMismatches: [] }],
          semanticResults: [{ passed: false, score: 0.3, reasoning: 'bad', metric: 'faithfulness' }],
          deterministicResults: [{ passed: false, metric: 'ratio', expected: 30, actual: 10, description: 'low' }],
        },
      ];

      const report = computeDrift(results);

      // 1 test failing all 3 categories is still ONE drifted test → 100%, not
      // 300%. Per-category counts are retained for reporting.
      expect(report.perSuite['context-engine'].zodFailures).toBe(1);
      expect(report.perSuite['context-engine'].semanticFailures).toBe(1);
      expect(report.perSuite['context-engine'].deterministicFailures).toBe(1);
      expect(report.perSuite['context-engine'].driftedTests).toBe(1);
      expect(report.aggregatePercent).toBe(100);
    });
  });

  describe('edge cases', () => {
    it('handles empty results', () => {
      const report = computeDrift([]);

      expect(report.aggregatePercent).toBe(0);
      expect(report.passed).toBe(true);
      expect(report.perSuite).toEqual({});
    });

    it('handles test cases with no assertions', () => {
      const results: TestCaseResults[] = [{
        suite: 'orchestrator',
        zodResults: [],
        semanticResults: [],
      }];

      const report = computeDrift(results);

      expect(report.aggregatePercent).toBe(0);
      expect(report.perSuite['orchestrator'].totalTests).toBe(1);
    });
  });
});
