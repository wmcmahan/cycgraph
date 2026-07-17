# Compression Benchmark Harness

Measures `@cycgraph/context-engine` against other compression engines the
credible way: **downstream task accuracy on a public dataset, against
baselines, across a compression-ratio curve, with paired statistics and a
reproduction command.**

## Methodology

- **Datasets**: two, chosen to stress different failure modes. Each has
  its own frozen config file; select with `--config`.
  - **HotpotQA distractor dev** (`bench.config.json`, default): multi-doc
    QA — 10 paragraphs per question, 2 gold + 8 distractors. Retrieval-
    shaped: picking the right documents is most of the game.
  - **MuSiQue-Ans dev** (`bench.musique.config.json`): the cross-segment
    stress test — 2-4 hop questions over 20 paragraphs, constructed to
    defeat single-paragraph shortcuts, so gold evidence spans up to 4
    segments. Downloaded from a pinned HuggingFace revision and verified
    against the config's `datasetSha256`. Question ids encode hop count
    (`2hop__…`) for per-hop breakdowns from raw results.

  Subset selection is a seeded shuffle of the full dev set; the subset
  file's SHA-256 is embedded in every report.
- **Task**: a reader model answers each question from the (compressed)
  context only. Scored with SQuAD-standard Exact Match and token-level F1.
  For datasets with answer aliases (MuSiQue), scoring takes the max over
  all gold surface forms — the official protocol.
- **Fairness**: every engine implements the same `CompressorAdapter`
  contract and receives the same questions, the same token budgets
  (measured by one shared counter), and the same reader model.
- **Matched budgets** (default, `budgetReference` in config): engines may
  compress *below* a budget cap, so target-ratio rows can sit at different
  achieved compression. The reference adapter runs first at the target
  ratios; every other engine then receives the reference's ACHIEVED
  per-question token counts as its budget — all cells in a ratio group sit
  at identical achieved compression. Disable with
  `--budget-reference none` for a plain target-cap run.
- **Baselines**: `none` (ceiling), `truncation-tail`/`truncation-head`
  (what callers do without an engine), `random-drop` (seeded; the floor).
- **Query-aware adapters are a separate comparison class.** Adapters named
  `*-query-aware` receive the question; the plain adapters don't. Compare
  query-aware rows against other query-aware engines or against their own
  query-agnostic twin (isolating the query signal's value) — never present
  them as the same configuration as the plain presets without labeling.
- **Statistics**: per-question paired F1 deltas vs the ceiling with 95%
  confidence intervals. Raw per-question results ship in the JSON output.

## Anti-fudging rules

1. `bench.config.json` is frozen and committed **before** running; its
   hash is stamped on every result.
2. The reported subset is never used to tune presets or thresholds.
3. Unavailable engines are reported as **skipped**, never silently omitted.
4. Negative results are published with the rest — the curve includes the
   ratios where compression hurts.
5. No `Math.random` anywhere — seeded PRNG only; runs are reproducible.

## Running

```bash
npm run bench:smoke        # bundled items, sanity only — never report these
npm run bench              # full run: downloads HotpotQA (~45MB, cached).
                           # Default reader: Claude (pinned claude-haiku-4-5-20251001,
                           # needs ANTHROPIC_API_KEY) — off-device and reproducible.
npx tsx src/bench/runner.ts --reader ollama --model qwen2.5:7b    # free local iteration
npx tsx src/bench/runner.ts --reader openai --model gpt-4o-mini   # third-party reader
npx tsx src/bench/runner.ts --questions 25                        # smaller subset
npx tsx src/bench/runner.ts --config bench.musique.config.json    # MuSiQue (multi-hop)
```

The reader default is pinned by dated model ID so published numbers stay
reproducible — never report against a floating alias or an unpinned local
quant. For extra credibility on public claims, also publish a table from a
third-party reader (`--reader openai`) so the package author's model vendor
isn't grading its own benchmark.

Results land in `bench-results/` (gitignored) as timestamped JSON with the
config hash in the filename; a markdown table prints to stdout.

Runs **checkpoint after every completed cell** to a `partial-*.json` in
`bench-results/` (deleted on successful completion). A killed run keeps
everything finished up to that point — resume with:

```bash
npx tsx src/bench/runner.ts --resume bench-results/partial-<stamp>.json
```

Resume refuses artifacts whose config hash or subset hash differ from the
current run — partial results never mix across experiments.

## Comparing against other engines

Implement `CompressorAdapter` (`src/bench/types.ts`) and add it to
`ADAPTER_REGISTRY` in `runner.ts`. Included:

- **LLMLingua-2** (`llmlingua-2`): Python bridge, default settings on both
  sides. Setup: `npm run bench:setup-llmlingua` (creates a venv under
  `bench-data/` and installs llmlingua; the first compression downloads the
  ~2GB LLMLingua-2 model from HuggingFace). Interpreter resolution:
  `BENCH_PYTHON` env var → the setup venv → `python3` on PATH. When
  unavailable, the report marks it skipped.

Selective Context or other Python engines follow the same bridge pattern
(`adapters/llmlingua_bridge.py` is the template).

## Publishing checklist

- [ ] Reader model pinned by exact version/tag (not `latest`)
- [ ] `subsetSize` >= 100, config committed before the run
- [ ] Competitor engines available (not skipped) or their absence disclosed
- [ ] Raw JSON artifact retained alongside the summary table
- [ ] Losses reported, not just wins
- [ ] Published tables generated with `npm run bench:report` from the raw
      artifacts (never hand-edited): it computes head-to-head paired
      significance, solvable-question retention, per-hop breakdowns
      (MuSiQue), an auto-collected negative-results section, and the full
      provenance/reproduction block. Output lives at
      `packages/context-engine/BENCHMARKS.md`.
