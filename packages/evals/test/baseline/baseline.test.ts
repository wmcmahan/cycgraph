/**
 * Tests for baseline persistence + comparison.
 *
 * Uses a temp directory so each test starts from a clean baseline state.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  snapshotFromDrift,
  writeBaseline,
  loadBaseline,
  compareBaseline,
  formatBaselineDelta,
  BASELINE_SCHEMA_VERSION,
} from '../../src/baseline/index.js';
import type { BaselineSnapshot } from '../../src/baseline/index.js';
import type { DriftReport } from '../../src/runner/types.js';

function makeDriftReport(overrides: Partial<DriftReport> = {}): DriftReport {
  return {
    aggregatePercent: 0,
    perSuite: {},
    passed: true,
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<BaselineSnapshot> = {}): BaselineSnapshot {
  return {
    schemaVersion: BASELINE_SCHEMA_VERSION,
    generatedAt: '2026-06-08T12:00:00.000Z',
    commit: 'abc1234',
    driftCeiling: 5,
    aggregateDrift: 0,
    passed: true,
    suites: {},
    ...overrides,
  };
}

let testDir: string;

beforeEach(() => {
  testDir = resolve(tmpdir(), `evals-baseline-${randomUUID()}`);
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true, force: true });
  }
});

describe('snapshotFromDrift', () => {
  it('preserves aggregate + per-suite drift in the snapshot', () => {
    const drift = makeDriftReport({
      aggregatePercent: 3.2,
      passed: true,
      perSuite: {
        orchestrator: {
          suiteName: 'orchestrator',
          totalTests: 18,
          zodFailures: 1,
          semanticFailures: 0,
          deterministicFailures: 0,
          driftPercent: 5.5,
        },
      },
    });

    const snapshot = snapshotFromDrift({
      drift,
      driftCeiling: 5,
      commit: 'abc1234',
      now: new Date('2026-06-08T12:00:00.000Z'),
    });

    expect(snapshot.schemaVersion).toBe(BASELINE_SCHEMA_VERSION);
    expect(snapshot.aggregateDrift).toBe(3.2);
    expect(snapshot.driftCeiling).toBe(5);
    expect(snapshot.commit).toBe('abc1234');
    expect(snapshot.suites.orchestrator.driftPercent).toBe(5.5);
    expect(snapshot.suites.orchestrator.zodFailures).toBe(1);
    expect(snapshot.suites.orchestrator.totalTests).toBe(18);
    expect(snapshot.generatedAt).toBe('2026-06-08T12:00:00.000Z');
  });

  it('defaults `now` to the current time when not provided', () => {
    const before = Date.now();
    const snapshot = snapshotFromDrift({
      drift: makeDriftReport(),
      driftCeiling: 5,
    });
    const generated = Date.parse(snapshot.generatedAt);
    expect(generated).toBeGreaterThanOrEqual(before);
    expect(generated).toBeLessThanOrEqual(Date.now());
  });
});

describe('writeBaseline + loadBaseline round-trip', () => {
  it('writes both main-latest and an archive file', () => {
    const snapshot = makeSnapshot({ aggregateDrift: 2.5 });
    const result = writeBaseline(snapshot, testDir);

    expect(existsSync(result.latestPath)).toBe(true);
    expect(existsSync(result.archivePath)).toBe(true);
    expect(result.archivePath).not.toBe(result.latestPath);
  });

  it('loads back the same snapshot bytes', () => {
    const snapshot = makeSnapshot({
      aggregateDrift: 7.5,
      passed: false,
      suites: {
        orchestrator: {
          driftPercent: 12,
          totalTests: 18,
          zodFailures: 2,
          semanticFailures: 1,
          deterministicFailures: 0,
        },
      },
    });

    writeBaseline(snapshot, testDir);
    const loaded = loadBaseline(testDir);

    expect(loaded).toEqual(snapshot);
  });

  it('returns null when no baseline exists', () => {
    expect(loadBaseline(testDir)).toBeNull();
  });

  it('throws on schema-version mismatch', () => {
    const badSnapshot = makeSnapshot();
    (badSnapshot as Record<string, unknown>).schemaVersion = '99';
    writeBaseline(badSnapshot as BaselineSnapshot, testDir);

    expect(() => loadBaseline(testDir)).toThrow(/schema version mismatch/);
  });

  it('archive filename includes both timestamp + commit', () => {
    const snapshot = makeSnapshot({
      generatedAt: '2026-06-08T12:34:56.000Z',
      commit: 'deadbeef',
    });
    const result = writeBaseline(snapshot, testDir);
    expect(result.archivePath).toMatch(/20260608T123456000Z-deadbeef\.json$/);
  });

  it('uses `nocommit` placeholder when commit is undefined', () => {
    const snapshot = makeSnapshot({
      generatedAt: '2026-06-08T12:34:56.000Z',
      commit: undefined,
    });
    const result = writeBaseline(snapshot, testDir);
    expect(result.archivePath).toMatch(/-nocommit\.json$/);
  });
});

describe('compareBaseline', () => {
  it('reports hasBaseline: false when no prior baseline exists', () => {
    const current = makeSnapshot({
      aggregateDrift: 2.5,
      suites: { orchestrator: makeSuiteEntry(2.5) },
    });

    const delta = compareBaseline(current, null);

    expect(delta.hasBaseline).toBe(false);
    expect(delta.regressions).toEqual([]);
    expect(delta.improvements).toEqual([]);
    expect(delta.newSuites).toEqual(['orchestrator']);
    expect(delta.hasRegression).toBe(false);
  });

  it('flags a suite that regressed by more than the noise floor', () => {
    const baseline = makeSnapshot({
      aggregateDrift: 1,
      suites: { orchestrator: makeSuiteEntry(1) },
    });
    const current = makeSnapshot({
      aggregateDrift: 9,
      suites: { orchestrator: makeSuiteEntry(9) },
    });

    const delta = compareBaseline(current, baseline);

    expect(delta.hasRegression).toBe(true);
    expect(delta.regressions).toHaveLength(1);
    expect(delta.regressions[0].suite).toBe('orchestrator');
    expect(delta.regressions[0].before).toBe(1);
    expect(delta.regressions[0].after).toBe(9);
    expect(delta.regressions[0].deltaPercent).toBe(8);
  });

  it('catches a sub-ceiling regression the drift ceiling would miss', () => {
    // 0% → 3% is below a typical 5% drift ceiling, so the absolute gate never
    // fires — but it IS a real regression. With the noise floor now well below
    // the ceiling, the baseline comparison flags it.
    const baseline = makeSnapshot({
      aggregateDrift: 0,
      suites: { orchestrator: makeSuiteEntry(0) },
    });
    const current = makeSnapshot({
      aggregateDrift: 3,
      suites: { orchestrator: makeSuiteEntry(3) },
    });

    const delta = compareBaseline(current, baseline);

    expect(delta.hasRegression).toBe(true);
    expect(delta.regressions[0].deltaPercent).toBe(3);
  });

  it('ignores changes smaller than the noise floor', () => {
    // Default noise floor is 1pp; a 0.5pp change is jitter, not a regression.
    const baseline = makeSnapshot({
      aggregateDrift: 1,
      suites: { orchestrator: makeSuiteEntry(1) },
    });
    const current = makeSnapshot({
      aggregateDrift: 1.5,
      suites: { orchestrator: makeSuiteEntry(1.5) },
    });

    const delta = compareBaseline(current, baseline);

    expect(delta.regressions).toHaveLength(0);
    expect(delta.improvements).toHaveLength(0);
  });

  it('honors a custom noise floor', () => {
    const baseline = makeSnapshot({
      suites: { orchestrator: makeSuiteEntry(1) },
    });
    const current = makeSnapshot({
      suites: { orchestrator: makeSuiteEntry(3) },
    });

    const delta = compareBaseline(current, baseline, { noiseFloor: 1 });
    expect(delta.regressions).toHaveLength(1);
  });

  it('reports improvements separately from regressions', () => {
    const baseline = makeSnapshot({
      aggregateDrift: 10,
      suites: { orchestrator: makeSuiteEntry(10) },
    });
    const current = makeSnapshot({
      aggregateDrift: 1,
      suites: { orchestrator: makeSuiteEntry(1) },
    });

    const delta = compareBaseline(current, baseline);

    expect(delta.regressions).toEqual([]);
    expect(delta.improvements).toHaveLength(1);
    expect(delta.improvements[0].deltaPercent).toBe(-9);
    expect(delta.hasRegression).toBe(false);
  });

  it('lists suites added or removed since the baseline', () => {
    const baseline = makeSnapshot({
      suites: {
        orchestrator: makeSuiteEntry(2),
        memory: makeSuiteEntry(0),
      },
    });
    const current = makeSnapshot({
      suites: {
        orchestrator: makeSuiteEntry(2),
        'context-engine': makeSuiteEntry(0),
      },
    });

    const delta = compareBaseline(current, baseline);

    expect(delta.newSuites).toEqual(['context-engine']);
    expect(delta.droppedSuites).toEqual(['memory']);
  });

  it('computes the aggregate drift delta across runs', () => {
    const baseline = makeSnapshot({ aggregateDrift: 3 });
    const current = makeSnapshot({ aggregateDrift: 7 });

    const delta = compareBaseline(current, baseline);
    expect(delta.aggregateDriftDelta).toBe(4);
  });
});

describe('formatBaselineDelta', () => {
  it('reports first-run scenario when no baseline exists', () => {
    const text = formatBaselineDelta({
      hasBaseline: false,
      aggregateDriftDelta: 0,
      regressions: [],
      improvements: [],
      newSuites: [],
      droppedSuites: [],
      hasRegression: false,
    });
    expect(text).toContain('No prior baseline');
  });

  it('lists regressions with pp deltas', () => {
    const text = formatBaselineDelta({
      hasBaseline: true,
      aggregateDriftDelta: 4,
      regressions: [{ suite: 'orchestrator', before: 1, after: 9, deltaPercent: 8 }],
      improvements: [],
      newSuites: [],
      droppedSuites: [],
      hasRegression: true,
    });
    expect(text).toContain('Regressions:');
    expect(text).toContain('orchestrator');
    expect(text).toContain('+8.0pp');
  });

  it('reports unchanged when nothing crosses the noise floor', () => {
    const text = formatBaselineDelta({
      hasBaseline: true,
      aggregateDriftDelta: 0.5,
      regressions: [],
      improvements: [],
      newSuites: [],
      droppedSuites: [],
      hasRegression: false,
    });
    expect(text).toContain('unchanged');
  });
});

function makeSuiteEntry(driftPercent: number) {
  return {
    driftPercent,
    totalTests: 10,
    zodFailures: 0,
    semanticFailures: 0,
    deterministicFailures: 0,
  };
}
