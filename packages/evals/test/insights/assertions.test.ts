/**
 * Tests for detectAssertionFailures (src/insights/assertions.ts).
 */

import { describe, it, expect } from 'vitest';
import { detectAssertionFailures } from '../../src/insights/assertions.js';
import { run } from './helpers.js';

const FAILED = { type: 'contains', passed: false };
const PASSED = { type: 'contains', passed: true };

describe('detectAssertionFailures', () => {
  it('reports an assertion that fails', () => {
    const findings = detectAssertionFailures([run({ runId: 'a', assertions: [FAILED] })]);

    expect(findings).toHaveLength(1);
    expect(findings[0]!.title).toBe("wf fails its 'contains' assertion");
  });

  it('stays silent when every assertion passes', () => {
    const findings = detectAssertionFailures([run({ runId: 'a', assertions: [PASSED] })]);

    expect(findings).toEqual([]);
  });

  it('rates a mostly-failing assertion high', () => {
    const findings = detectAssertionFailures([
      run({ runId: 'a', assertions: [FAILED] }),
      run({ runId: 'b', assertions: [FAILED] }),
      run({ runId: 'c', assertions: [PASSED] }),
    ]);

    expect(findings[0]!.severity).toBe('high');
  });

  it('rates an occasionally-failing assertion medium', () => {
    const findings = detectAssertionFailures([
      run({ runId: 'a', assertions: [FAILED] }),
      run({ runId: 'b', assertions: [PASSED] }),
      run({ runId: 'c', assertions: [PASSED] }),
    ]);

    expect(findings[0]!.severity).toBe('medium');
  });

  it('counts only runs that carried assertions as the denominator', () => {
    const findings = detectAssertionFailures([
      run({ runId: 'a', assertions: [FAILED] }),
      run({ runId: 'b', assertions: [PASSED] }),
      run({ runId: 'c' }),
      run({ runId: 'd' }),
    ]);

    expect(findings[0]!.evidence.of).toBe(2);
  });

  it('groups assertions that failed in the same runs into one finding', () => {
    const findings = detectAssertionFailures([
      run({
        runId: 'a',
        assertions: [{ type: 'contains', passed: false }, { type: 'json_schema', passed: false }],
      }),
    ]);

    expect(findings).toHaveLength(1);
    expect(findings[0]!.id).toBe('assertion:wf:contains+json_schema');
  });

  it('names every assertion in a grouped finding', () => {
    const findings = detectAssertionFailures([
      run({
        runId: 'a',
        assertions: [{ type: 'contains', passed: false }, { type: 'json_schema', passed: false }],
      }),
    ]);

    expect(findings[0]!.title).toBe('wf fails 2 assertions together: contains, json_schema');
  });

  it('separates assertions that failed in different runs', () => {
    const findings = detectAssertionFailures([
      run({ runId: 'a', assertions: [{ type: 'contains', passed: false }, { type: 'json_schema', passed: true }] }),
      run({ runId: 'b', assertions: [{ type: 'contains', passed: true }, { type: 'json_schema', passed: false }] }),
    ]);

    expect(findings.map(f => f.id).sort()).toEqual([
      'assertion:wf:contains',
      'assertion:wf:json_schema',
    ]);
  });

  it('separates the same assertion across workflows', () => {
    const findings = detectAssertionFailures([
      run({ runId: 'a', workflow: 'one', assertions: [FAILED] }),
      run({ runId: 'b', workflow: 'two', assertions: [FAILED] }),
    ]);

    expect(findings.map(f => f.workflow).sort()).toEqual(['one', 'two']);
  });

  it('carries the assertion messages into the detail', () => {
    const findings = detectAssertionFailures([
      run({ runId: 'a', assertions: [{ type: 'contains', passed: false, message: 'missing summary' }] }),
    ]);

    expect(findings[0]!.detail).toContain('missing summary');
  });

  it('deduplicates repeated messages across runs', () => {
    const findings = detectAssertionFailures([
      run({ runId: 'a', assertions: [{ type: 'contains', passed: false, message: 'same' }] }),
      run({ runId: 'b', assertions: [{ type: 'contains', passed: false, message: 'same' }] }),
    ]);

    expect(findings[0]!.detail.match(/same/g)).toHaveLength(1);
  });

  it('caps the sample run ids it carries', () => {
    const runs = ['a', 'b', 'c', 'd', 'e', 'f'].map(runId => run({ runId, assertions: [FAILED] }));

    const findings = detectAssertionFailures(runs);

    expect(findings[0]!.evidence.sampleRunIds).toHaveLength(5);
    expect(findings[0]!.evidence.runs).toBe(6);
  });

  it('returns nothing for an empty corpus', () => {
    expect(detectAssertionFailures([])).toEqual([]);
  });
});
