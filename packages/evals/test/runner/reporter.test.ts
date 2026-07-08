import { describe, it, expect } from 'vitest';
import { formatReport } from '../../src/runner/reporter.js';
import type { DriftReport } from '../../src/runner/types.js';

function makeReport(overrides: Partial<DriftReport> = {}): DriftReport {
  return {
    aggregatePercent: 0,
    perSuite: {},
    passed: true,
    ...overrides,
  };
}

describe('formatReport', () => {
  describe('text output', () => {
    it('includes report header', () => {
      const report = makeReport();
      const output = formatReport(report, 'local');

      expect(output.text).toContain('EVAL HARNESS');
      expect(output.text).toContain('DRIFT REPORT');
    });

    it('shows PASS for passing report', () => {
      const report = makeReport({ passed: true, aggregatePercent: 2.5 });
      const output = formatReport(report, 'local');

      expect(output.text).toContain('PASS');
      expect(output.text).toContain('2.5%');
    });

    it('shows FAIL for failing report', () => {
      const report = makeReport({ passed: false, aggregatePercent: 8.3 });
      const output = formatReport(report, 'local');

      expect(output.text).toContain('FAIL');
      expect(output.text).toContain('8.3%');
    });

    it('includes per-suite breakdown', () => {
      const report = makeReport({
        perSuite: {
          orchestrator: {
            suiteName: 'orchestrator',
            totalTests: 10,
            zodFailures: 1,
            semanticFailures: 0,
            deterministicFailures: 0,
            driftedTests: 1,
            driftPercent: 10,
          },
          memory: {
            suiteName: 'memory',
            totalTests: 5,
            zodFailures: 0,
            semanticFailures: 0,
            deterministicFailures: 0,
            driftedTests: 0,
            driftPercent: 0,
          },
        },
      });

      const output = formatReport(report, 'local');

      expect(output.text).toContain('orchestrator');
      expect(output.text).toContain('10 tests');
      expect(output.text).toContain('1 zod');
      expect(output.text).toContain('memory');
      expect(output.text).toContain('5 tests');
    });

    it('shows PASS for suites with zero drift', () => {
      const report = makeReport({
        perSuite: {
          orchestrator: {
            suiteName: 'orchestrator',
            totalTests: 5,
            zodFailures: 0,
            semanticFailures: 0,
            deterministicFailures: 0,
            driftPercent: 0,
          },
        },
      });

      const output = formatReport(report, 'local');

      expect(output.text).toMatch(/PASS\s+orchestrator/);
    });
  });

  describe('CI annotations', () => {
    it('produces no annotations in local mode', () => {
      const report = makeReport({ passed: false, aggregatePercent: 10 });
      const output = formatReport(report, 'local');

      expect(output.annotations).toEqual([]);
    });

    it('produces error annotation when drift gate fails', () => {
      const report = makeReport({ passed: false, aggregatePercent: 7.5 });
      const output = formatReport(report, 'ci');

      expect(output.annotations.some(a => a.startsWith('::error'))).toBe(true);
      expect(output.annotations.some(a => a.includes('7.5%'))).toBe(true);
    });

    it('produces warning annotations for suite failures', () => {
      const report = makeReport({
        passed: false,
        aggregatePercent: 10,
        perSuite: {
          orchestrator: {
            suiteName: 'orchestrator',
            totalTests: 10,
            zodFailures: 2,
            semanticFailures: 1,
            deterministicFailures: 0,
            driftPercent: 30,
          },
        },
      });

      const output = formatReport(report, 'ci');

      const zodWarning = output.annotations.find(a => a.includes('Zod Failures'));
      const semanticWarning = output.annotations.find(a => a.includes('Semantic Failures'));

      expect(zodWarning).toContain('2 structural');
      expect(semanticWarning).toContain('1 semantic');
    });

    it('produces no annotations when all suites pass', () => {
      const report = makeReport({
        passed: true,
        aggregatePercent: 0,
        perSuite: {
          orchestrator: {
            suiteName: 'orchestrator',
            totalTests: 5,
            zodFailures: 0,
            semanticFailures: 0,
            deterministicFailures: 0,
            driftPercent: 0,
          },
        },
      });

      const output = formatReport(report, 'ci');

      expect(output.annotations).toEqual([]);
    });
  });
});
