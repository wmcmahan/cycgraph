<div align="center">

# @cycgraph/evals

**Regression-test harness for agent workflows. Deterministic + LLM-as-judge assertions, multi-sample evaluation, baseline drift gates.**

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](../../LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-339933?logo=node.js&logoColor=white)](https://nodejs.org)

[📚 Documentation](https://flattop.io/docs/concepts/eval-harness/) &nbsp;·&nbsp; [🏃 Running evals](https://flattop.io/docs/guides/running-eval-harness/) &nbsp;·&nbsp; [📖 Assertions reference](https://flattop.io/docs/concepts/eval-assertions/) &nbsp;·&nbsp; [📐 Drift and baselines](https://flattop.io/docs/concepts/drift-and-baselines/)

</div>

---

Quality-assurance gate for the `@cycgraph/*` packages. Detects when a change in one package silently degrades the reasoning, schema compliance, or observable behavior of another, and tells you whether the regression is real or just sample noise.

This README is the **quick-start + API at-a-glance**. For concepts (drift gates, baseline persistence, sample stability), recording workflows, and extension recipes, see the [Eval Harness section](https://flattop.io/docs/concepts/eval-harness/) of the docs site.

## What it gives you

- **54 golden trajectories** across 3 suites (`orchestrator`, `memory`, `context-engine`) with stable IDs and provenance.
- **Two assertion tracks**:
  - **Deterministic** — pure library calls (no LLM): segmentation, dedup, budget, subgraph, conflict detection, etc.
  - **Semantic** — LLM-as-judge with three built-in rubric metrics (`answer_relevancy`, `faithfulness`, `logical_coherence`). Three reference-free metrics (`instruction_following`, `output_quality`, `safety`) are exposed but not yet wired into a default suite.
- **Multi-sample evaluation** — distinguishes flaky LLM responses from genuine regressions.
- **Baseline persistence** — compares each run against the prior committed state and flags regressions that hide under the absolute drift ceiling.
- **Recording infrastructure** — re-record any trajectory by running the input through the real System-Under-Test; goldens become observable behavior, not hand-authored intent.
- **Tag-routed dispatch** — `branching` / `supervisor` / `retry` / etc. trajectories pick the right SUT graph automatically.
- **Efficacy + bench runners** — sibling CLIs (`evals:efficacy`, `bench`) that measure absolute extraction/compression quality rather than drift.

## Quick start

### Run the deterministic track (no LLM, <1s)

```bash
npm run evals --workspace=packages/evals -- --deterministic-only
```

Runs every library-level test across context-engine and memory. The orchestrator suite is semantic-only, so it doesn't appear in deterministic runs. Suitable for PR-time gating.

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

The first run with `--baseline` creates `golden/baselines/main-latest.json`. Subsequent runs compare against it and exit with code **2** if any suite regressed by more than the noise floor (default 1 percentage point), even when the absolute drift ceiling hasn't been crossed.

## CLI flags

| Flag | Type | Default | Purpose |
|------|------|---------|---------|
| `--mode` | `local \| ci` | `local` | Picks provider (Ollama / GPT-4o) + default concurrency |
| `--suite` | suite name | (all) | Restrict to a single suite |
| `--samples` | int | 1 local, 3 ci | Number of judge samples per semantic test |
| `--deterministic-only` | flag | false | Skip the semantic track entirely (library checks only) |
| `--baseline` | flag | false | Compare against persisted baseline; persist on pass |
| `--baseline-noise-floor` | float | 1 | Min pp delta to count as a regression |
| `--sut-model` | string | `claude-sonnet-4-6` | Model for the orchestrator SUT |
| `--provider` | `anthropic \| openai \| ollama` | (per mode) | Override the judge provider the mode would pick |
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
| `ANTHROPIC_API_KEY` | Recording, `--provider anthropic` | — | Claude API key for orchestrator recording and the Anthropic judge |
| `OLLAMA_BASE_URL` | Local only | `http://localhost:11434` | Ollama endpoint |
| `OLLAMA_MODEL` | Local only | `llama3:8b-instruct-q4_K_M` | Local judge model |
| `EVAL_DRIFT_CEILING` | No | `5.0` | Drift % gate threshold |

Judge concurrency is a provider option (`maxConcurrency`), not an env var: 2 for Ollama, 8 for OpenAI and Anthropic.

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

Recording runs through the `scripts/record-goldens.ts` script, which drives each input through the real System-Under-Test and rewrites the golden dataset. See [Re-record goldens](#re-record-goldens) above for usage. The SUT layer it uses (`runOrchestratorSut`, `runMemorySut`, `runContextEngineSut`, the `build*Graph` builders, `planForTrajectory`, the retry-tool fixtures) is **not** part of the package barrel; it lives under `src/sut/` and is consumed by the recording script via relative imports.

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

Both tracks are commit-coupled: the deterministic track runs library code in-process, and the SUT-driven semantic track runs each trajectory through `runSutDispatch` against the real packages, then hands the observed output to the judge. When `samples > 1`, the semantic track runs N independent judge samples per metric and flags tests with inconsistent outcomes as **flaky**, which is distinct from genuine drift.

## Development

```bash
# Unit tests for the harness itself (~590 tests; LLM-backed suites skip without keys)
npm test --workspace=packages/evals

# Build
npm run build --workspace=packages/evals

# Type check
npm run lint --workspace=packages/evals

# Efficacy matrix (extraction/compression quality vs labeled corpora)
npm run evals:efficacy --workspace=packages/evals

# Compression bench (context engine vs reference compressors; --smoke for a quick pass)
npm run bench --workspace=packages/evals
```

Covers assertions, dataset I/O, schema migration, SUT dispatch, multi-sample evaluation, baseline persistence/comparison, and runner integration.

## Related

- [`@cycgraph/orchestrator`](../orchestrator/) — the system under test
- [`@cycgraph/memory`](../memory/) — knowledge-graph SUT
- [`@cycgraph/context-engine`](../context-engine/) — compression SUT
- Orchestrator's [internal `runEval`](https://flattop.io/docs/observability/evals/) — lightweight per-graph assertion framework (different from this package's regression harness)
- [`examples/eval-gated-learning/`](./examples/eval-gated-learning/) — runnable demo of the eval-gated retention loop (poisoned lessons evicted on outcome evidence)

## Contributing

Issues and PRs welcome on [GitHub](https://github.com/wmcmahan/cycgraph). See [CONTRIBUTING.md](https://github.com/wmcmahan/cycgraph/blob/main/CONTRIBUTING.md).

## License

[Apache 2.0](https://github.com/wmcmahan/cycgraph/blob/main/LICENSE).