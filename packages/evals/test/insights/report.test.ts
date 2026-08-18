/**
 * Tests for buildInsightsReport and formatInsightsReport (src/insights/report.ts).
 */

import { describe, it, expect } from 'vitest';
import { buildInsightsReport, formatInsightsReport } from '../../src/insights/report.js';
import type { Detector, Finding } from '../../src/insights/types.js';
import { run, warn } from './helpers.js';

function finding(partial: Partial<Finding> & Pick<Finding, 'id' | 'severity'>): Finding {
  return {
    detector: 'fake',
    workflow: 'wf',
    title: partial.id,
    detail: '',
    evidence: { runs: 1, occurrences: 1, sampleRunIds: ['a'], of: 1 },
    addresses: '',
    ...partial,
  };
}

function fixed(...findings: Finding[]): Detector {
  return () => findings;
}

describe('buildInsightsReport', () => {
  it('reports how much of the corpus it examined', () => {
    const report = buildInsightsReport([
      run({ runId: 'a', workflow: 'one' }),
      run({ runId: 'b', workflow: 'two' }),
      run({ runId: 'c', workflow: 'two' }),
    ], []);

    expect(report.runs).toBe(3);
    expect(report.workflows).toBe(2);
  });

  it('gathers findings from every detector', () => {
    const report = buildInsightsReport([], [
      fixed(finding({ id: 'one', severity: 'low' })),
      fixed(finding({ id: 'two', severity: 'low' })),
    ]);

    expect(report.findings.map(f => f.id)).toEqual(['one', 'two']);
  });

  it('ranks high severity ahead of low', () => {
    const report = buildInsightsReport([], [
      fixed(
        finding({ id: 'quiet', severity: 'low' }),
        finding({ id: 'loud', severity: 'high' }),
        finding({ id: 'middling', severity: 'medium' }),
      ),
    ]);

    expect(report.findings.map(f => f.id)).toEqual(['loud', 'middling', 'quiet']);
  });

  it('ranks by rate rather than raw count within a severity', () => {
    const report = buildInsightsReport([], [
      fixed(
        finding({
          id: 'common-but-rare',
          severity: 'high',
          evidence: { runs: 10, occurrences: 10, sampleRunIds: [], of: 400 },
        }),
        finding({
          id: 'rare-but-pervasive',
          severity: 'high',
          evidence: { runs: 4, occurrences: 4, sampleRunIds: [], of: 5 },
        }),
      ),
    ]);

    expect(report.findings.map(f => f.id)).toEqual(['rare-but-pervasive', 'common-but-rare']);
  });

  it('breaks ties by id so two passes over one corpus agree', () => {
    const report = buildInsightsReport([], [
      fixed(finding({ id: 'zebra', severity: 'low' }), finding({ id: 'alpha', severity: 'low' })),
    ]);

    expect(report.findings.map(f => f.id)).toEqual(['alpha', 'zebra']);
  });

  it('counts findings per severity', () => {
    const report = buildInsightsReport([], [
      fixed(
        finding({ id: 'a', severity: 'high' }),
        finding({ id: 'b', severity: 'high' }),
        finding({ id: 'c', severity: 'low' }),
      ),
    ]);

    expect(report.counts).toEqual({ high: 2, medium: 0, low: 1 });
  });

  it('runs the real detectors by default', () => {
    const report = buildInsightsReport([
      run({ runId: 'a', logs: [warn('x.max_iterations_reached')], assertions: [{ type: 'c', passed: false }] }),
      run({ runId: 'b', logs: [warn('x.max_iterations_reached')], assertions: [{ type: 'c', passed: false }] }),
    ]);

    expect(report.findings.map(f => f.detector).sort()).toEqual(['assertions', 'signals']);
  });

  it('produces an empty report for an empty corpus', () => {
    const report = buildInsightsReport([]);

    expect(report).toEqual({ runs: 0, workflows: 0, findings: [], counts: { high: 0, medium: 0, low: 0 } });
  });
});

describe('formatInsightsReport', () => {
  it('says so plainly when nothing was found', () => {
    const report = buildInsightsReport([run({ runId: 'a' })], []);

    expect(formatInsightsReport(report)).toBe('Nothing found across 1 run(s) of 1 workflow(s).');
  });

  it('renders each finding with its severity, detail, and samples', () => {
    const report = buildInsightsReport([], [
      fixed(finding({
        id: 'one',
        severity: 'high',
        title: 'draft retries',
        detail: '2 of 3 runs',
        addresses: 'transient failure',
      })),
    ]);

    const text = formatInsightsReport(report);

    expect(text).toContain('[high] draft retries');
    expect(text).toContain('2 of 3 runs');
    expect(text).toContain('addresses: transient failure');
    expect(text).toContain('1 sample run(s): a');
  });

  it('leads with a severity summary', () => {
    const report = buildInsightsReport([], [
      fixed(finding({ id: 'a', severity: 'high' }), finding({ id: 'b', severity: 'low' })),
    ]);

    expect(formatInsightsReport(report).split('\n')[1]).toBe('  1 high · 0 medium · 1 low');
  });
});
