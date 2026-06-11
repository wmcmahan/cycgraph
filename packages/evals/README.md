<div align="center">

# @cycgraph/evals

**Regression-test harness for agent workflows. Deterministic + LLM-as-judge assertions, multi-sample evaluation, baseline drift gates.**

[![npm](https://img.shields.io/npm/v/@cycgraph/evals?color=cb3837)](https://www.npmjs.com/package/@cycgraph/evals)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](../../LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D24-339933?logo=node.js&logoColor=white)](https://nodejs.org)

[📚 Documentation](https://flattop.io/concepts/eval-harness/) &nbsp;·&nbsp; [📖 Assertions reference](https://flattop.io/concepts/eval-assertions/) &nbsp;·&nbsp; [📐 Drift and baselines](https://flattop.io/concepts/drift-and-baselines/)

</div>

---

Quality-assurance gate for the `@cycgraph/*` packages. Detects when a change in one package silently degrades the reasoning, schema-compliance, or observable behaviour of another — and tells you whether the regression is real or just sample noise.

This README is the **quick-start + API at-a-glance**. For concepts (drift gates, baseline persistence, sample stability), recording workflows, and extension recipes, see the [Eval Harness section](https://flattop.io/concepts/eval-harness/) of the docs site.

## What it gives you

- **54 golden trajectories** across 3 suites (`orchestrator`, `memory`, `context-engine`) with stable IDs and provenance.
- **Two assertion tracks**:
  - **Deterministic** — pure library calls (no LLM): segmentation, dedup, budget, subgraph, conflict detection, etc.
  - **Semantic** — LLM-as-judge with three built-in rubric metrics (`answer_relevancy`, `faithfulness`, `logical_coherence`) plus three reference-free metrics (`instruction_following`, `output_quality`, `safety`).
- **Multi-sample evaluation** — distinguishes flaky LLM responses from genuine regressions.
- **Baseline persistence** — compares each run against the prior committed state and flags regressions that hide under the absolute drift ceiling.
- **Recording infrastructure** — re-record any trajectory by running the input through the real System-Under-Test; goldens become observable behaviour, not hand-authored intent.
- **Tag-routed dispatch** — `branching` / `supervisor` / `retry` / etc. trajectories pick the right SUT graph automatically.

## Quick start

### Run the deterministic track (no LLM, <1s)

```bash
npm run evals --workspace=packages/evals -- --deterministic-only
```

Runs every library-level test across memory + context-engine + integration. Suitable for PR-time gating.

### Run the full semantic gate (CI mode)

```bash
OPENAI_API_KEY=sk-... npm run evals:ci --workspace=packages/evals
```

Uses GPT-4o as the judge with 3 samples per metric and the OpenAI provider. Reports per-suite drift, flaky tests, and baseline delta.

### Re-record goldens

```bash
# Memory + context-engine — no LLM needed
npx tsx packages/evals/scripts/record-goldens.ts --suite memory
npx tsx packages/evals/scripts/record-goldens.ts --suite context-engine

# Orchestrator — requires Anthropic key, real LLM calls
ANTHROPIC_API_KEY=sk-ant-... \
  npx tsx packages/evals/scripts/record-goldens.ts --suite orchestrator

# Preview routing without running anything
npx tsx packages/evals/scripts/record-goldens.ts --suite memory --plan-only

# Actually overwrite the SQLite dataset
npx tsx packages/evals/scripts/record-goldens.ts --suite memory --commit
```

A dry-run writes `golden/recording-diff-<suite>.json` with old vs new for every trajectory. Inspect that before passing `--commit`.

### Compare against a baseline

```bash
npm run evals --workspace=packages/evals -- --deterministic-only --baseline
```

The first run with `--baseline` creates `golden/baselines/main-latest.json`. Subsequent runs compare against it and exit with code **2** if any suite regressed by more than the noise floor (default 5 percentage points), even when the absolute drift ceiling hasn't been crossed.

## CLI flags

| Flag | Type | Default | Purpose |
|------|------|---------|---------|
| `--mode` | `local \| ci` | `local` | Picks provider (Ollama / GPT-4o) + default concurrency |
| `--suite` | suite name | (all) | Restrict to a single suite |
| `--samples` | int | 1 local, 3 ci | Number of judge samples per semantic test |
| `--deterministic-only` | flag | false | Skip the semantic track entirely (library checks only) |
| `--baseline` | flag | false | Compare against persisted baseline; persist on pass |
| `--baseline-noise-floor` | float | 5.0 | Min pp delta to count as a regression |
| `--sut-model` | string | `claude-sonnet-4-20250514` | Model for the orchestrator SUT |
| `--commit` | string | (auto) | Short git SHA stamped onto a new baseline snapshot |

### Exit codes

| Code | Meaning |
|------|---------|
| 0 | Drift gate passed, no baseline regression |
| 1 | Drift gate failed OR a suite failed to load |
| 2 | Baseline regression detected, drift gate passed |

## Configuration

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `OPENAI_API_KEY` | CI only | — | GPT-4o judge API key |
| `ANTHROPIC_API_KEY` | Recording only | — | Claude API key for orchestrator recording |
| `OLLAMA_BASE_URL` | Local only | `http://localhost:11434` | Ollama endpoint |
| `OLLAMA_MODEL` | Local only | `llama3:8b-instruct-q4_K_M` | Local judge model |
| `EVAL_MAX_CONCURRENCY` | No | `2` / `8` | Parallel evaluations (local / CI) |
| `EVAL_DRIFT_CEILING` | No | `5.0` | Drift % gate threshold |

## API at a glance

### Assertions

```typescript
import {
  // Structural — schema-level checks on tool calls
  assertToolCallStructure, assertTrajectoryStructure,
  // Deterministic — pure numeric/set/stability checks
  assertGreaterThanOrEqual, assertLessThanOrEqual,
  assertContainsAllKeys, assertSetEquals, assertStable, assertEqual,
  // Semantic — built-in LLM rubric metrics
  ANSWER_RELEVANCY, FAITHFULNESS, LOGICAL_COHERENCE, BUILT_IN_METRICS,
  // Reference-free — score without a comparison output
  INSTRUCTION_FOLLOWING, OUTPUT_QUALITY, SAFETY, REFERENCE_FREE_METRICS,
} from '@cycgraph/evals';
```

### Multi-sample semantic evaluation

```typescript
import { evaluateMetricMultiSample, ANSWER_RELEVANCY } from '@cycgraph/evals';

const result = await evaluateMetricMultiSample(
  { input, actualOutput, expectedOutput },
  ANSWER_RELEVANCY,
  callJudge,
  { samples: 3, threshold: 0.8 },
);
// { median, stdDev, samples, stable, passed, reasoning }
```

### Baseline persistence

```typescript
import {
  snapshotFromDrift, writeBaseline, loadBaseline,
  compareBaseline, formatBaselineDelta,
} from '@cycgraph/evals';

const snapshot = snapshotFromDrift({ drift, driftCeiling: 5, commit: 'abc1234' });
writeBaseline(snapshot);
const delta = compareBaseline(snapshot, loadBaseline());
console.log(formatBaselineDelta(delta));
```

### Recording

```typescript
import {
  runOrchestratorSut, runMemorySut, runContextEngineSut,
  buildSupervisorGraph, buildSingleAgentGraph, buildBranchingGraph,
  buildRetryGraph, createFlakyFetch, createRateLimitedCall,
  planForTrajectory,
} from '@cycgraph/evals';
```

### Dataset

```typescript
import {
  loadGoldenTrajectories, loadManifest, listAvailableSuites,
  writeGoldenDataset, createSqliteBuffer, applyMigrations,
} from '@cycgraph/evals';
```

### Runner

```typescript
import { runEvals } from '@cycgraph/evals';

const result = await runEvals({
  mode: 'local',
  deterministicOnly: true,
  baseline: true,
  samples: 3,
});
// { drift, raw, suiteLoadErrors, baselineDelta?, flakyTests? }
```

## Golden dataset

Trajectories are stored as compressed SQLite (`.sqlite.gz`) under `golden/data/`, indexed by `golden/manifest.json` with sha256 checksums. The manifest is the source of truth for what's recorded; SQLite blobs are the data.

```
golden/
├── manifest.json               # Versioned index with sha256
├── data/
│   ├── orchestrator-v1.sqlite.gz
│   ├── memory-v1.sqlite.gz
│   └── context-engine-v1.sqlite.gz
└── baselines/                  # (gitignored) per-run baseline snapshots
    └── main-latest.json
```

**Schema migration** — when a tool signature changes in a sibling package, `scripts/migrate-golden.ts` applies ordered transforms (rename / remove / add-required) to keep trajectories in sync without manual replay.

## Architecture

```
            ┌────────────────────────────┐
            │     runEvals(config)       │
            └─────────────┬──────────────┘
                          │
       ┌──────────────────┼──────────────────┐
       ▼                  ▼                  ▼
  Deterministic    SUT-driven Semantic    Baseline
   (static         (runSutDispatch →       (load → compare
    registry)       evaluateMetricMulti)    → write on pass)
       │                  │                  │
       └────────┬─────────┘                  │
                ▼                            │
         computeDrift()                      │
                ▼                            │
         DriftReport ◄───────────────────────┘
                ▼
         formatReport() → stdout + GH annotations
```

Both tracks are commit-coupled — the deterministic track runs library code in-process, and the SUT-driven semantic track runs each trajectory through `runSutDispatch` against the real packages, then hands the observed output to the judge. The semantic track also runs N independent judge samples per metric (when `samples > 1`) and flags tests with inconsistent outcomes as **flaky** — distinct from genuine drift.

## Development

```bash
# Unit tests for the harness itself (338 tests)
npm test --workspace=packages/evals

# Build
npm run build --workspace=packages/evals

# Type check
npm run lint --workspace=packages/evals
```

Covers assertions, dataset I/O, schema migration, SUT dispatch, multi-sample evaluation, baseline persistence/comparison, and runner integration.

## Related

- [`@cycgraph/orchestrator`](../orchestrator/) — the system under test
- [`@cycgraph/memory`](../memory/) — knowledge-graph SUT
- [`@cycgraph/context-engine`](../context-engine/) — compression SUT
- Orchestrator's [internal `runEval`](https://flattop.io/observability/evals/) — lightweight per-graph assertion framework (different from this package's regression harness)

## Contributing

Issues and PRs welcome on [GitHub](https://github.com/wmcmahan/cycgraph). See [CONTRIBUTING.md](https://github.com/wmcmahan/cycgraph/blob/main/CONTRIBUTING.md).

## License

[Apache 2.0](https://github.com/wmcmahan/cycgraph/blob/main/LICENSE).