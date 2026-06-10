---
title: Drift & Baselines
description: How the eval harness aggregates assertion results into a single drift metric and detects regressions against the prior baseline.
---

The eval harness turns hundreds of per-test pass/fail outcomes into two numbers a gate can reason about: a **drift percentage** for absolute quality, and a **baseline delta** for relative regression. This page explains what each one means and how they're computed.

## The drift metric

After running both tracks, `computeDrift()` aggregates per-test failures into a single percentage per suite and across the run.

```text
suite_drift_% = (zodFailures + semanticFailures + deterministicFailures) / totalTests * 100
aggregate_drift_% = sum(failures across suites) / sum(totalTests across suites) * 100
```

A test is "failed" if *any* assertion attached to it failed — structural, deterministic, or semantic. That makes the gate strict by default; relax per-suite if you need to.

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

Flaky tests show up in the report as warnings and contribute to a `flakyTests` field on the runner result:

```text
[eval] 2 flaky test(s) (inconsistent across samples):
  - orchestrator: passRate=67% over 3 samples
  - memory: passRate=33% over 3 samples
```

Treating flaky and drifted differently means a flaky judge doesn't burn build credibility — the team knows it's a judge problem, not a code problem.

## Baselines

The drift ceiling tells you whether the current run is *acceptable* in absolute terms. A baseline tells you whether the current run is *worse than the previous one* in relative terms — even when both pass the absolute gate.

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

Each archived copy lands at `golden/baselines/<timestamp>-<commit>.json` so the full history is queryable, but `main-latest.json` is what subsequent runs compare against.

### Computing a delta

`compareBaseline()` walks both snapshots and returns a `BaselineDelta`:

| Field | Meaning |
|---|---|
| `hasBaseline` | False on the first-ever baseline run |
| `aggregateDriftDelta` | Net pp change. Positive = worse. |
| `regressions` | Suites whose drift increased by ≥ `noiseFloor` (default 5pp) |
| `improvements` | Suites whose drift decreased by ≥ `noiseFloor` |
| `newSuites` | Present in current, absent from baseline |
| `droppedSuites` | Present in baseline, absent from current |
| `hasRegression` | Convenience flag: `regressions.length > 0` |

The default 5pp noise floor absorbs sample-to-sample LLM jitter. Tighten it via `--baseline-noise-floor 1` for stricter detection, or loosen it if your judge is particularly noisy.

### Persistence rules

A baseline is overwritten when **both** conditions hold:
1. The current run passed the absolute drift gate
2. The current run did not regress against the prior baseline

This avoids the goalpost-moving failure mode: if the gate fails or the run regressed, the prior baseline stays put so the next run still has a meaningful comparison.

### Reading a baseline delta

```text
── Baseline ──
Regressions:
  - memory: 0.0% → 5.6% (+5.6pp)
Improvements:
  - context-engine: 8.3% → 2.8% (-5.5pp)
```

The runner emits a separate exit code (`2`) when `hasRegression` is true and the drift gate passed. That gives CI a way to distinguish "drift gate broken" (`1`) from "got worse but still within budget" (`2`).

## Exit-code reference

| Code | Drift gate | Baseline | Meaning |
|---|---|---|---|
| 0 | Pass | OK or not run | Clean run |
| 1 | Fail | — | Gate failed OR a suite couldn't load |
| 2 | Pass | Regression | Worse than baseline, still within absolute budget |

Wire these into your CI step's `continue-on-error` policy according to taste. A common pattern is to hard-fail on `1` and warn-only on `2`.

## Related

- [Eval Harness](/docs/concepts/eval-harness/) — overall architecture
- [Eval Assertions](/docs/concepts/eval-assertions/) — what feeds into the drift number
- [Running Evals](/docs/guides/running-eval-harness/) — the CLI flags that surface these features
