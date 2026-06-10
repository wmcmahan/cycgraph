---
title: Recording Goldens
description: Capture observable behavior from real System-Under-Test runs and commit them as the new regression anchor.
---

Goldens are the reference points against which drift is measured. Each golden becomes a snapshot of what the code actually produced at a tagged commit.

## The recording script

```bash
npx tsx packages/evals/scripts/record-goldens.ts --suite <suite> [flags]
```

| Flag | Default | What it does |
|---|---|---|
| `--suite` | `orchestrator` | Which suite to record |
| `--model` | `claude-sonnet-4-20250514` | Recording model (orchestrator only) |
| `--samples` | `3` | Samples per trajectory for stability checking |
| `--commit` | (off — dry run) | Actually overwrite the SQLite dataset |
| `--plan-only` | off | Print the routing table and exit; no SUT invocations |
| `--output` | `golden/recording-diff-<suite>.json` | Where to write the diff report |

## Preview routing without running anything

`--plan-only` shows which graph builder or handler each trajectory dispatches to. Useful when adding a new trajectory tag and verifying the planner picks it up:

```bash
$ npx tsx scripts/record-goldens.ts --suite orchestrator --plan-only

[record-goldens] suite=orchestrator model=claude-sonnet-4-20250514 ...
  [1/18] PLAN   e503a104 Single-node: research TypeScript history — graph=single-agent tool=web_search
  [2/18] PLAN   0c9fbbc0 Single-node: summarize document — graph=single-agent tool=web_search
  ...
  [10/18] PLAN  9b71dc96 Delegation: research and writing team — graph=supervisor tool=none
  ...

[record-goldens] plan totals: supported=18 skipped=0
```

Any unsupported trajectories show up as `SKIP` with a reason (e.g., "No reference graph for tags [some-future-tag] yet").

## Dry run (default)

Without `--commit`, the script samples each trajectory, builds the diff report, and writes it to disk — but does **not** overwrite the SQLite dataset.

```bash
$ npx tsx scripts/record-goldens.ts --suite memory

[record-goldens] suite=memory model=... samples=3 commit=false plan-only=false
  [1/18] REC   e759f3ad Segmentation: time-gap based episode splitting
  ...
  [18/18] REC  5ed8519c Conflict: no false positive on unrelated facts

[record-goldens] Diff written to: golden/recording-diff-memory.json
[record-goldens] Totals: recorded=18 skipped=0 unstable=0 errored=0
[record-goldens] Dry run — pass --commit to overwrite the SQLite dataset.
```

The diff report contains, for each trajectory:
- The old hand-authored or recorded `expectedOutput`
- The new observed output
- All raw sample data (for unstable cases, you can see exactly which sample diverged)

Inspect this before committing. Look for:
- Tests that switched from passing-against-intent to failing-against-reality (good — finds wrong goldens)
- Tests that flipped meaning entirely (suspicious — investigate)
- Unstable tests where samples disagreed (judge or library is non-deterministic; investigate before committing)

## Commit

```bash
npx tsx scripts/record-goldens.ts --suite memory --commit
```

Refuses to commit if any trajectory errored or was unstable across samples — the script's job is to lock in stable behavior, not paper over fragility.

On commit, the script:
1. Writes `golden/data/<suite>-v1.sqlite.gz` with the new trajectories
2. Updates `golden/manifest.json` (sha256, count, schema version, timestamp)
3. Tags each new trajectory with `source: 'recorded'` + `recordedAt` + `recordedModel` + `recordedCommit`

## Per-suite specifics

### Memory + context-engine (no LLM)

Recording is a deterministic library snapshot. Each trajectory's input runs through the appropriate library API (segmenter, extractor, dedup, etc.) and the output is serialized as the new expected value.

```bash
npx tsx scripts/record-goldens.ts --suite memory
npx tsx scripts/record-goldens.ts --suite context-engine
```

No API keys required. Takes <2s.

### Orchestrator (requires Anthropic key)

Each trajectory's input is mapped to a reference graph by tag:
- `linear` / `basic` / `no-tools` → `single-agent`
- `supervisor` / `multi-agent` / `delegation` → `supervisor`
- `branching` / `conditional` → `branching`
- `error` / `retry` → `retry` (with mocked flaky tool fixtures)
- `budget` / `state` → `single-agent` (with appropriate mocked tools)

The graph runs through `GraphRunner` against the real LLM. Tool calls go through a mock resolver so recording is network-free apart from the LLM itself.

```bash
ANTHROPIC_API_KEY=sk-ant-... \
  npx tsx scripts/record-goldens.ts --suite orchestrator
```

Cost is bounded by the per-trajectory token estimate × 18 trajectories × 3 samples. For Sonnet, that's roughly $0.50–$1.00 per recording session.

## Stability checking

Every recording invocation samples each trajectory N times (default 3) and verifies that all samples produced the same tool-call sequence shape. If they didn't:

- The trajectory is flagged `unstable` in the diff
- The script refuses to commit
- The unstable samples are included in the diff so you can see what diverged

This catches:
- Non-determinism in the LLM (which is expected sometimes)
- Race conditions in the graph runner
- Tool fixtures with state leaking across samples (this should be impossible — fixtures are constructed per-sample — but if it happens the stability check catches it)

## After recording

```bash
# Confirm the new dataset round-trips through the schema
npm test --workspace=packages/evals

# Run the eval harness against the new goldens
npm run evals --workspace=packages/evals -- --deterministic-only

# If you want a fresh baseline against the new goldens
rm -f packages/evals/golden/baselines/main-latest.json
npm run evals --workspace=packages/evals -- --deterministic-only --baseline
```

Commit the `.sqlite.gz` files + the updated manifest together; reviewers can spot-check by re-running the recording locally.

## Related

- [Eval Harness](/docs/concepts/eval-harness/) — why goldens are recorded rather than authored
- [Adding a SUT Handler](/docs/guides/adding-sut-handler/) — extend the recorder to cover a new tag family
- [Adding an Eval Suite](/docs/guides/adding-eval-suite/) — add an entirely new suite
