---
title: Drift & Baselines
description: How the eval harness aggregates assertion results into a single drift metric and detects regressions against the prior baseline.
---

The eval harness turns hundreds of per-test pass/fail outcomes into two numbers a gate can reason about: a **drift percentage** for absolute quality, and a **baseline delta** for relative regression. This page explains what each one means and how they're computed.

## The drift metric

After running both tracks, `computeDrift()` aggregates per-test failures into a single percentage per suite and across the run.

```text
suite_drift_% = driftedTests / totalTests * 100
aggregate_drift_% = sum(driftedTests across suites) / sum(totalTests across suites) * 100
```

A test is "drifted" if *any* assertion attached to it failed, whether structural, deterministic, or semantic. A test that fails several ways is counted once, so drift is a true fraction of tests in `[0, 100]` rather than a sum of failure events. The per-category counts (`zodFailures`, `semanticFailures`, `deterministicFailures`) are reported for diagnosis, but the numerator of the percentage is `driftedTests`. That makes the gate strict by default. Relax it per-suite if you need to.

**Refs:**
- [`computeDrift`](#computedrift): Aggregate per-test results into a drift report.
- [DriftReport](#driftreport): The aggregate + per-suite result shape.
- [SuiteDriftSummary](#suitedriftsummary): One suite's failure breakdown.
- [TestCaseResults](#testcaseresults): The per-test input `computeDrift` consumes.

### Reading a drift report

```text
═══════════════════════════════════════════════
  EVAL HARNESS — DRIFT REPORT
═══════════════════════════════════════════════

  PASS  context-engine — 18 tests — drift 0.0%
  DRIFT memory — 18 tests — drift 5.6% (1 zod)
  PASS  orchestrator — 18 tests — drift 0.0%

───────────────────────────────────────────────
  FAIL  Aggregate Drift: 1.9%
───────────────────────────────────────────────
```

Each suite line shows total tests, drift percentage, and a breakdown of which assertion family caused the failures. The aggregate line is what the gate compares against `EVAL_DRIFT_CEILING` (default `5.0`).

## Flaky vs drifted

A single LLM judge sample is non-deterministic. Without protection, one bad call can either tank the gate (false alarm) or hide a real regression (false confidence). When the runner is invoked with `--samples N` (default 3 in CI), each semantic test runs N times. The harness classifies each test's outcome:

| Pass rate across samples | Classification |
|---|---|
| `100%` | Passed |
| `0%` | Drifted (stable failure) |
| `> 50%` and `< 100%` | Passed but **flaky** |
| `> 0%` and `≤ 50%` | Failed and flaky |

Flaky tests show up in the report as warnings and populate the `flakyTests` field on the runner result:

```text
[eval] 2 flaky test(s) (inconsistent across samples):
  - orchestrator: passRate=67% over 3 samples
  - memory: passRate=33% over 3 samples
```

Treating flaky and drifted differently means a flaky judge doesn't burn build credibility. The team knows it's a judge problem, not a code problem.

**Refs:**
- [EvalResult](#evalresult): Carries `flakyTests` alongside the drift report and baseline delta.

## Baselines

The drift ceiling tells you whether the current run is *acceptable* in absolute terms. A baseline tells you whether the current run is *worse than the previous one* in relative terms, even when both pass the absolute gate.

### Snapshot anatomy

When `--baseline` is set on a passing run, the harness writes `golden/baselines/main-latest.json`:

```json
{
  "schemaVersion": "1",
  "generatedAt": "2026-06-08T18:44:30.353Z",
  "commit": "abc1234",
  "mode": "ci",
  "driftCeiling": 5,
  "aggregateDrift": 0.5,
  "passed": true,
  "suites": {
    "memory": {
      "driftPercent": 0,
      "totalTests": 18,
      "zodFailures": 0,
      "semanticFailures": 0,
      "deterministicFailures": 0
    }
  }
}
```

`snapshotFromDrift()` builds this shape from the runtime drift report. Each archived copy lands at `golden/baselines/<timestamp>-<commit>.json` so the full history is queryable, but `main-latest.json` is what subsequent runs compare against.

**Refs:**
- [`snapshotFromDrift`](#snapshotfromdrift): Convert a runtime drift report into a persisted snapshot.
- [BaselineSnapshot](#baselinesnapshot): The persisted snapshot shape.
- [BaselineSuiteEntry](#baselinesuiteentry): One suite's entry inside a snapshot.

### Computing a delta

`compareBaseline()` walks both snapshots and returns a [`BaselineDelta`](#baselinedelta): the net aggregate change, the suites that regressed or improved past the noise floor, and any suites that were added or dropped.

The default 1pp noise floor absorbs sample-to-sample LLM jitter while staying well below the absolute drift ceiling. That gap is deliberate: a suite drifting 0% → 4% is caught as a regression even though it clears a 5% ceiling. A noise floor equal to the ceiling was a blind spot, because a 0% → 4.9% suite was neither a regression (below the floor) nor a ceiling failure (below the ceiling), so sub-ceiling regressions went invisible. Raise the floor with `--baseline-noise-floor 5` if your judge is particularly noisy, or lower it further for stricter detection.

**Refs:**
- [`compareBaseline`](#comparebaseline): Diff a current snapshot against the prior baseline.
- [BaselineDelta](#baselinedelta): The diff result shape.
- [SuiteDelta](#suitedelta): One suite's before/after drift change.
- [CompareBaselineOptions](#comparebaselineoptions): The `noiseFloor` knob.

### Persistence rules

A baseline is overwritten when **all three** conditions hold:

1. The current run passed the absolute drift gate
2. The current run did not regress against the prior baseline
3. The current run's `aggregateDrift` is **not worse** than the prior baseline's (`current.aggregateDrift <= baseline.aggregateDrift`)

This avoids the goalpost-moving failure mode: if the gate fails or the run regressed, the prior baseline stays put so the next run still has a meaningful comparison. The third condition is the anti-boiling-frog guard: the baseline moves *down* on genuine improvement or holds, but never ratchets upward, so drift creeping up by less than the noise floor each run can't quietly reset the anchor higher every time.

`writeBaseline()` performs the write. It emits `main-latest.json` plus a timestamped archive copy and returns both paths.

**Refs:**
- [`writeBaseline`](#writebaseline): Persist a snapshot to `golden/baselines/`.
- [`loadBaseline`](#loadbaseline): Read the latest snapshot, or `null` on the first run.
- [WriteBaselineResult](#writebaselineresult): The `latestPath` / `archivePath` return shape.

### Reading a baseline delta

```text
── Baseline ──
Regressions:
  - memory: 0.0% → 5.6% (+5.6pp)
Improvements:
  - context-engine: 8.3% → 2.8% (-5.5pp)
```

`formatBaselineDelta()` renders this summary for the reporter. The runner emits a separate exit code (`2`) when `hasRegression` is true and the drift gate passed. That gives CI a way to distinguish "drift gate broken" (`1`) from "got worse but still within budget" (`2`).

**Refs:**
- [`formatBaselineDelta`](#formatbaselinedelta): Render a delta as a compact human-readable summary.

## Exit-code reference

| Code | Drift gate | Baseline | Meaning |
|---|---|---|---|
| 0 | Pass | OK or not run | Clean run |
| 1 | Fail | — | Gate failed OR a suite couldn't load |
| 2 | Pass | Regression | Worse than baseline, still within absolute budget |

Wire these into your CI step's `continue-on-error` policy according to taste. A common pattern is to hard-fail on `1` and warn-only on `2`.

## API

### `computeDrift`

Aggregate per-test results into a drift report, computing the drift percentage per suite and across the run. A test counts as drifted if it failed in at least one assertion category.

```typescript
computeDrift(testResults: TestCaseResults[], driftCeiling?: number): DriftReport
```

`driftCeiling` defaults to `5.0`. The report's `passed` flag is `aggregatePercent < driftCeiling`.

### `snapshotFromDrift`

Convert a runtime [`DriftReport`](#driftreport) into a persistable [`BaselineSnapshot`](#baselinesnapshot). Keeping the conversion in one place lets the writer, loader, and comparator stay schema-stable while the runtime types evolve.

```typescript
snapshotFromDrift(input: SnapshotInput): BaselineSnapshot
```

### `writeBaseline`

Persist a snapshot under `golden/baselines/`, creating the directory tree if needed. Writes `main-latest.json` plus a timestamped archive copy, and is idempotent within a run: the same snapshot produces the same bytes on disk.

```typescript
writeBaseline(snapshot: BaselineSnapshot, goldenDir?: string): WriteBaselineResult
```

`goldenDir` defaults to the package's `golden/` directory.

### `loadBaseline`

Read the most-recent baseline from `golden/baselines/main-latest.json`. Returns `null` (not a throw) when no baseline file exists, so callers can tell "first run, no baseline yet" from genuine corruption. A JSON parse error or a schema-version mismatch does throw.

```typescript
loadBaseline(goldenDir?: string): BaselineSnapshot | null
```

### `compareBaseline`

Diff a current snapshot against the prior baseline. A suite regresses when `after - before >= noiseFloor` and improves when `before - after >= noiseFloor`. When `baseline` is `null`, returns a delta with `hasBaseline: false`, every current suite listed under `newSuites`, and no regressions.

```typescript
compareBaseline(
  current: BaselineSnapshot,
  baseline: BaselineSnapshot | null,
  options?: CompareBaselineOptions,
): BaselineDelta
```

### `formatBaselineDelta`

Render a [`BaselineDelta`](#baselinedelta) as a compact human-readable summary for the reporter. Returns a "no prior baseline" line on the first run, and an "unchanged within noise floor" line when nothing crossed the threshold.

```typescript
formatBaselineDelta(delta: BaselineDelta): string
```

## Interfaces

### DriftReport

The aggregate drift report `computeDrift` returns. `aggregatePercent` is the gate metric.

| Field | Type | Description |
|---|---|---|
| `aggregatePercent` | `number` | Aggregate drift percentage across all suites. |
| `perSuite` | `Record<string, SuiteDriftSummary>` | Per-suite breakdown, keyed by suite name. |
| `passed` | `boolean` | Whether the run cleared the drift ceiling gate. |

### SuiteDriftSummary

One suite's drift breakdown inside a [`DriftReport`](#driftreport).

| Field | Type | Description |
|---|---|---|
| `suiteName` | `string` | Suite this summary describes. |
| `totalTests` | `number` | Total tests in the suite. |
| `zodFailures` | `number` | Tests with a failing zod structural assertion. |
| `semanticFailures` | `number` | Tests with a failing semantic judge assertion. |
| `deterministicFailures` | `number` | Tests with a failing deterministic assertion. |
| `driftedTests` | `number` | Tests that failed in at least one category, counted once. The numerator of `driftPercent`. |
| `driftPercent` | `number` | `driftedTests / totalTests * 100`. |

### TestCaseResults

The per-test input `computeDrift` consumes. One entry per test case, carrying its results across all assertion tracks.

| Field | Type | Description |
|---|---|---|
| `suite` | `string` | Suite this test belongs to. |
| `zodResults` | `ZodStructuralResult[]` | Zod structural results for the test's tool calls. Empty when no tool calls are expected. |
| `semanticResults` | `SemanticJudgeResult[]` | Semantic judge results. Empty when the semantic track was skipped. |
| `deterministicResults` | `DeterministicResult[]` | Optional. Deterministic assertion results. Empty when the deterministic track was skipped. |

### EvalResult

The complete result of an eval run, returned by `runEvals`.

| Field | Type | Description |
|---|---|---|
| `drift` | `DriftReport` | Computed drift report with the gate pass/fail. |
| `raw` | `unknown` | Raw per-test results across both tracks. |
| `suiteLoadErrors` | `SuiteLoadError[]` | Suites that failed to load. A non-empty array should be treated as a gate failure, because a missing suite produces zero tests and would otherwise pass the drift gate trivially. |
| `baselineDelta` | `BaselineDelta` | Optional. Baseline comparison result when the run set `baseline: true`. Undefined otherwise. |
| `flakyTests` | `Array<{ suite: string; passRate: number; samples: number }>` | Optional. Tests with inconsistent outcomes across samples. Empty when `samples: 1`. |

### BaselineSnapshot

A point-in-time record of eval state, persisted as JSON under `golden/baselines/`.

| Field | Type | Description |
|---|---|---|
| `schemaVersion` | `'1'` | Snapshot schema version. Equals `BASELINE_SCHEMA_VERSION`. |
| `generatedAt` | `string` | ISO timestamp the snapshot was captured. |
| `commit` | `string` | Optional. Short git SHA at capture time, when available. |
| `mode` | `string` | Optional. Run mode (`local` / `ci`) for context. |
| `driftCeiling` | `number` | Drift ceiling in effect when the snapshot was taken. |
| `aggregateDrift` | `number` | Aggregate drift percentage at snapshot time. |
| `passed` | `boolean` | Whether the snapshot represents a passing run. |
| `suites` | `Record<string, BaselineSuiteEntry>` | Per-suite snapshot, keyed by suite name. |

### BaselineSuiteEntry

One suite's stored breakdown inside a [`BaselineSnapshot`](#baselinesnapshot).

| Field | Type | Description |
|---|---|---|
| `driftPercent` | `number` | Suite drift percentage at snapshot time. |
| `totalTests` | `number` | Total tests in the suite. |
| `zodFailures` | `number` | Failing zod structural tests. |
| `semanticFailures` | `number` | Failing semantic judge tests. |
| `deterministicFailures` | `number` | Failing deterministic tests. |

### BaselineDelta

The difference between a current run and the prior baseline, returned by [`compareBaseline`](#comparebaseline).

| Field | Type | Description |
|---|---|---|
| `hasBaseline` | `boolean` | Whether a baseline existed to compare against. `false` on the first-ever run. |
| `aggregateDriftDelta` | `number` | Net aggregate-drift change. Positive is worse, negative is better. |
| `regressions` | `SuiteDelta[]` | Suites whose drift increased by at least `noiseFloor`. |
| `improvements` | `SuiteDelta[]` | Suites whose drift decreased by at least `noiseFloor`. |
| `newSuites` | `string[]` | Suites present in the current run but absent from the baseline. |
| `droppedSuites` | `string[]` | Suites present in the baseline but absent from the current run. |
| `hasRegression` | `boolean` | Convenience flag: `regressions.length > 0`. |

### SuiteDelta

One per-suite change detected against the baseline.

| Field | Type | Description |
|---|---|---|
| `suite` | `string` | Suite this change describes. |
| `before` | `number` | Drift percent in the baseline snapshot. |
| `after` | `number` | Drift percent in the current run. |
| `deltaPercent` | `number` | Absolute change (`after - before`). Positive is a regression, negative is an improvement. |

### SnapshotInput

The input to [`snapshotFromDrift`](#snapshotfromdrift).

| Field | Type | Default | Description |
|---|---|---|---|
| `drift` | `DriftReport` | — | The runtime drift report to convert. |
| `driftCeiling` | `number` | — | Drift ceiling to record on the snapshot. |
| `commit` | `string` | — | Optional. Short git SHA at capture time. |
| `mode` | `string` | — | Optional. Run mode label (`local` / `ci`). |
| `now` | `Date` | `new Date()` | Optional. Override the generation timestamp for deterministic tests. |

### CompareBaselineOptions

Options for [`compareBaseline`](#comparebaseline).

| Field | Type | Default | Description |
|---|---|---|---|
| `noiseFloor` | `number` | `1` | Minimum absolute percent change to count as a regression or improvement. Smaller deltas are treated as noise. Kept well below the drift ceiling so sub-ceiling regressions are still caught. |

### WriteBaselineResult

The return value of [`writeBaseline`](#writebaseline).

| Field | Type | Description |
|---|---|---|
| `latestPath` | `string` | Absolute path to the always-current `main-latest.json`. |
| `archivePath` | `string` | Absolute path to the archived per-timestamp file. |

## Next steps

- [Eval Harness](/docs/concepts/eval-harness/): overall architecture
- [Eval Assertions](/docs/concepts/eval-assertions/): what feeds into the drift number
- [Running Evals](/docs/guides/running-eval-harness/): the CLI flags that surface these features
