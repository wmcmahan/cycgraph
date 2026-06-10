---
title: Eval Harness
description: Regression-eval harness and quality-assurance gate for @cycgraph/* packages.
---

The **Eval Harness** (`@cycgraph/evals`) is the regression-detection layer for the project. It runs golden trajectories through the real `@cycgraph/orchestrator`, `@cycgraph/memory`, and `@cycgraph/context-engine` packages, captures observable behavior, and tells you whether a change in one package silently broke another.

It's distinct from the orchestrator's lightweight built-in [`runEval`](/docs/observability/evals/) (which is a per-graph assertion framework). `@cycgraph/evals` operates one level up — it gates whole-package behavior across release cycles.

## When to reach for this package

- You shipped a change to one package and want to know if it altered observable behavior elsewhere
- You want a stable signal for "did the LLM judge actually regress, or was it a flaky sample?"
- You want to detect drift that hides under your absolute gate (e.g., a suite going from 0% to 4% drift while the ceiling is 5%)
- You need a record of what the system *actually does* on a tagged commit so future regressions are attributable

## Architecture

```mermaid
flowchart TD
  CLI["npm run evals --workspace=packages/evals"]
  CLI --> Runner["runEvals(config)"]
  Runner --> Det["Deterministic Track<br/>(in-process library calls)"]
  Runner --> Sem["SUT-driven Semantic Track<br/>(runSutDispatch + multi-sample)"]
  Det --> Drift["computeDrift()"]
  Sem --> Drift
  Drift --> Report["DriftReport"]
  Report --> Baseline["compareBaseline()"]
  Baseline --> Delta["BaselineDelta"]
  Report --> Out["stdout + GH annotations"]
  Delta --> Out

  Goldens[("golden/data/*.sqlite.gz")] -. drives .-> Det
  Goldens -. drives .-> Sem
```

### Two tracks, one gate

- **Deterministic track** — pure library calls in-process, no LLM. Fast (<1s), free, and produces sharp signal: segmentation, dedup, budget allocation, subgraph extraction, conflict detection, etc.
- **Semantic track** — SUT-driven: each trajectory is dispatched through the real package code via `runSutDispatch`, and the LLM judge grades the observed output against the recorded golden. Configurable provider (Ollama locally, GPT-4o in CI) and configurable sample count for stability.

Both tracks feed into a single `DriftReport` aggregated by `computeDrift()`. The gate triggers when aggregate drift exceeds the configured ceiling.

### Multi-sample stability

LLM judges are non-deterministic. A single low-scoring run can tank the gate; a single high-scoring run can mask a real regression. The semantic track defaults to **3 samples per metric in CI**, using a majority-vote outcome and surfacing tests with inconsistent results as **flaky** — distinct from drift failure.

See [Drift & Baselines](/docs/concepts/drift-and-baselines/) for how flaky-vs-regressed is distinguished in the report.

## Related

- [Eval Assertions](/docs/concepts/eval-assertions/) — the four assertion families and when to use each
- [Drift & Baselines](/docs/concepts/drift-and-baselines/) — what the drift metric means and how baselines extend it
- [Running Evals](/docs/guides/running-eval-harness/) — CLI usage end to end
- [Recording Goldens](/docs/guides/recording-goldens/) — re-record from real SUT runs
- [Adding an Eval Suite](/docs/guides/adding-eval-suite/) — build a new suite from scratch
- [Adding a SUT Handler](/docs/guides/adding-sut-handler/) — extend the SUT to cover a new tag family
