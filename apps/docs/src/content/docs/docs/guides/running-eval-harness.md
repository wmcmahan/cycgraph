---
title: Running the Eval Harness
description: Practical CLI usage for @cycgraph/evals — local, CI, deterministic-only, multi-sample, and baseline modes.
---

The eval harness has one entry point — `npm run evals` — and a handful of flags that compose. This guide walks through the modes you'll actually use.

## The four common modes

### 1. Fast local sanity check (no LLM)

```bash
npm run evals --workspace=packages/evals -- --deterministic-only
```

Runs ~36 library-level tests in <1 second. Catches:
- Compression ratio regressions
- Dedup behavior changes
- Budget enforcement breaks
- Memory segmentation, temporal filtering, subgraph extraction
- Conflict detection rules

Use as a pre-commit hook or a fast PR signal. Does not exercise any LLM-bound code path.

### 2. Full local evaluation (Ollama)

```bash
npm run evals --workspace=packages/evals
```

Runs both tracks against a local Ollama model. Free but slower (~30s) and the judge is weaker than a frontier model — useful for "does this even compile" but not for production gating.

### 3. Full CI evaluation (GPT-4o, multi-sample)

```bash
OPENAI_API_KEY=sk-... npm run evals:ci --workspace=packages/evals
```

Same as local but:
- Uses `gpt-4o` as the judge
- 3 samples per semantic test (instead of 1)
- Higher concurrency (`8` vs `2`)
- Hides the progress bar (CI-friendly output)

The CI mode is what should run in scheduled regression checks. Cost is bounded by the per-test estimate; you'll see a warning if the projection exceeds `$5`.

### 4. Baselined CI evaluation

```bash
OPENAI_API_KEY=sk-... \
  npm run evals:ci --workspace=packages/evals -- --baseline
```

Adds baseline comparison on top of mode 3:
- Loads `golden/baselines/main-latest.json`
- Compares current drift to the prior snapshot
- Exits with code `2` if any suite regressed by more than 5pp (configurable)
- Overwrites the baseline only if the run passed both the absolute gate and the relative comparison

See [Drift & Baselines](/docs/concepts/drift-and-baselines/) for what counts as a regression.

## CLI reference

| Flag | Type | Default | What it does |
|---|---|---|---|
| `--mode` | `local \| ci` | `local` | Picks provider, concurrency, sample defaults |
| `--suite` | suite name | 3 core suites | Restricts to one suite. Default runs `context-engine`, `memory`, `orchestrator`; `integration` is accepted but drives no goldens (see note). |
| `--samples` | int | 1 local / 3 ci | Number of independent semantic samples per test |
| `--sut-model` | string | `claude-sonnet-4-6` | Model driving the system-under-test (SUT) on the semantic track |
| `--deterministic-only` | flag | false | Skip the semantic track entirely |
| `--baseline` | flag | false | Load + compare + persist `golden/baselines/main-latest.json` |
| `--baseline-noise-floor` | float | `5.0` | Minimum pp delta to flag as a regression |
| `--commit` | string | (auto) | Short git SHA stamped onto a new baseline snapshot |

:::note
`--suite integration` is a valid flag, but no golden dataset ships for it — the manifest only carries goldens for `orchestrator`, `memory`, and `context-engine` (18 trajectories each), and `integration` is excluded from the default suite set. Selecting it runs nothing against goldens until you record integration trajectories.
:::

### Combining flags

These compose freely. Some useful combinations:

```bash
# One suite only
npm run evals -- --suite memory

# Multi-sample to detect flakiness, no baseline
npm run evals:ci -- --samples 5

# Tight baseline tolerance
npm run evals:ci -- --baseline --baseline-noise-floor 1.0

# CI mode but only library tests (fast PR gate without API costs)
npm run evals -- --deterministic-only
```

## Environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `OPENAI_API_KEY` | CI semantic track | — | GPT-4o judge |
| `OLLAMA_BASE_URL` | Local | `http://localhost:11434` | Ollama endpoint |
| `OLLAMA_MODEL` | Local | `llama3:8b-instruct-q4_K_M` | Local judge model |
| `EVAL_MAX_CONCURRENCY` | No | `2` / `8` | Parallel evaluations |
| `EVAL_DRIFT_CEILING` | No | `5.0` | Drift % gate threshold |

CLI flags override env vars where both apply.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Clean run |
| `1` | Drift gate failed OR a suite failed to load |
| `2` | Baseline regression detected but drift gate passed |

For CI scripts, the canonical pattern is to hard-fail on `1` and warn-only (or open an issue) on `2`.

## Output

By default the runner writes to stdout. CI mode additionally emits GitHub Actions annotations (`::error`, `::warning`) so failures appear inline on PRs.

Future enhancements (deferred from Phase 1):
- Structured `report.json` artifact
- GitHub step summary
- JUnit XML for test-result aggregators

## Troubleshooting

**"Ollama: connection refused"** — Start the server with `ollama serve`. Confirm the model is pulled: `ollama list`.

**"Cost warning: estimated $X exceeds threshold"** — The CI mode estimates total token usage. The default warning fires at $5; raise it via the provider option in code or accept it and continue (the warning is non-blocking).

**"Baseline schema version mismatch"** — You're loading an older snapshot than the current code understands. Delete `golden/baselines/main-latest.json` and re-run with `--baseline` to bootstrap a fresh one.

**"No prior baseline"** — Expected on the first run with `--baseline`. The current run becomes the baseline.

## Related

- [Eval Harness](/docs/concepts/eval-harness/) — what's running under the hood
- [Recording Goldens](/docs/guides/recording-goldens/) — refresh the trajectories the harness uses
- [Drift & Baselines](/docs/concepts/drift-and-baselines/) — what the numbers mean
