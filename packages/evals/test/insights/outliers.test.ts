/**
 * Tests for detectOutliers and computeMs (src/insights/outliers.ts).
 */

import { describe, it, expect } from 'vitest';
import { computeMs, detectOutliers } from '../../src/insights/outliers.js';
import { ran, run, timing, usage } from './helpers.js';

describe('computeMs', () => {
  it('sums the time every node spent executing', () => {
    const total = computeMs(run({
      runId: 'r',
      nodeTiming: { a: timing(300), b: timing(700) },
    }));

    expect(total).toBe(1000);
  });

  it('returns nothing when no timing was attributed', () => {
    expect(computeMs(run({ runId: 'r' }))).toBeUndefined();
  });

  it('ignores wall clock entirely', () => {
    const total = computeMs(run({ runId: 'r', durationMs: 30_961, nodeTiming: ran(4) }));

    expect(total).toBe(4);
  });
});

describe('detectOutliers', () => {
  const NORMAL = [10_000, 10_500, 9_500, 10_200, 9_800];

  function timed(durations: readonly number[], params?: Record<string, unknown>) {
    return durations.map((ms, index) => run({
      runId: `r${index}`,
      nodeTiming: ran(ms),
      model: 'm',
      ...(params ? { params } : {}),
    }));
  }

  it('reports a run that executed far longer than comparable runs', () => {
    const findings = detectOutliers(timed([...NORMAL, 900_000]));

    expect(findings).toHaveLength(1);
    expect(findings[0]!.evidence.sampleRunIds).toEqual(['r5']);
  });

  it('collects every slow run into one finding', () => {
    const findings = detectOutliers(timed([...NORMAL, 900_000, 800_000]));

    expect(findings).toHaveLength(1);
    expect(findings[0]!.evidence.runs).toBe(2);
  });

  it('measures execution time rather than wall clock', () => {
    const findings = detectOutliers([
      ...NORMAL.map((ms, i) => run({ runId: `r${i}`, nodeTiming: ran(ms), durationMs: 5, model: 'm' })),
      run({ runId: 'paused', nodeTiming: ran(10_100), durationMs: 900_000, model: 'm' }),
    ]);

    expect(findings).toEqual([]);
  });

  it('reports a run whose wall clock hid how long it executed', () => {
    const findings = detectOutliers([
      ...NORMAL.map((ms, i) => run({ runId: `r${i}`, nodeTiming: ran(ms), durationMs: 900_000, model: 'm' })),
      run({ runId: 'busy', nodeTiming: ran(900_000), durationMs: 900_000, model: 'm' }),
    ]);

    expect(findings[0]!.evidence.sampleRunIds).toEqual(['busy']);
  });

  it('ignores a gap too small to be worth acting on', () => {
    const findings = detectOutliers(timed([70, 72, 68, 74, 66, 152]));

    expect(findings).toEqual([]);
  });

  it('ignores a run that is slower but not proportionally so', () => {
    const findings = detectOutliers(timed([10_000, 10_100, 9_900, 10_050, 9_950, 13_000]));

    expect(findings).toEqual([]);
  });

  it('needs enough comparable runs before a median describes anything', () => {
    const findings = detectOutliers(timed([10_000, 900_000]));

    expect(findings).toEqual([]);
  });

  it('ignores runs with no recorded timing', () => {
    const findings = detectOutliers([
      run({ runId: 'a' }), run({ runId: 'b' }), run({ runId: 'c' }),
      run({ runId: 'd' }), run({ runId: 'e' }), run({ runId: 'f', nodeTiming: ran(900_000) }),
    ]);

    expect(findings).toEqual([]);
  });

  it('never compares runs given different parameters', () => {
    const findings = detectOutliers([
      ...NORMAL.map((ms, i) => run({ runId: `flat${i}`, nodeTiming: ran(ms), model: 'm', params: { nested: false } })),
      run({ runId: 'nested', nodeTiming: ran(900_000), model: 'm', params: { nested: true } }),
    ]);

    expect(findings).toEqual([]);
  });

  it('never compares runs made against different models', () => {
    const findings = detectOutliers([
      ...NORMAL.map((ms, i) => run({ runId: `small${i}`, nodeTiming: ran(ms), model: 'small' })),
      run({ runId: 'large', nodeTiming: ran(900_000), model: 'large' }),
    ]);

    expect(findings).toEqual([]);
  });

  it('compares runs only against the same workflow', () => {
    const findings = detectOutliers([
      ...NORMAL.map((ms, i) => run({ runId: `q${i}`, workflow: 'quick', nodeTiming: ran(ms), model: 'm' })),
      run({ runId: 'slow', workflow: 'lengthy', nodeTiming: ran(900_000), model: 'm' }),
    ]);

    expect(findings).toEqual([]);
  });

  it('ignores parameters every run agrees on', () => {
    const findings = detectOutliers(timed([...NORMAL, 900_000], { subject: 'batteries' }));

    expect(findings).toHaveLength(1);
  });

  it('says what it treated as comparable when parameters vary', () => {
    const findings = detectOutliers([
      ...[...NORMAL, 900_000].map((ms, i) =>
        run({ runId: `a${i}`, nodeTiming: ran(ms), model: 'm', params: { nested: false } })),
      run({ runId: 'b', nodeTiming: ran(5000), model: 'm', params: { nested: true } }),
    ]);

    expect(findings[0]!.detail).toContain('comparable meaning m nested=false');
  });

  it('reports how many comparable runs were slow', () => {
    const findings = detectOutliers(timed([...NORMAL, 900_000]));

    expect(findings[0]!.detail).toBe(
      '1 of 6 comparable runs, up to 900000ms of node time against a median of 10100ms',
    );
  });

  it('derives an id that names the workflow and what made runs comparable', () => {
    const findings = detectOutliers(timed([...NORMAL, 900_000]));

    expect(findings[0]!.id).toBe('outlier:duration:wf:m');
  });

  it('never reports a token finding', () => {
    const findings = detectOutliers([
      run({
        runId: 'r',
        nodeTiming: { hog: timing(10), a: timing(10), b: timing(10) },
        byNode: { hog: usage(100_000), a: usage(1), b: usage(1) },
      }),
    ]);

    expect(findings).toEqual([]);
  });

  it('returns nothing for an empty corpus', () => {
    expect(detectOutliers([])).toEqual([]);
  });
});
