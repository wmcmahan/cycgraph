# Compound Learning Benchmark

Measures the thing cycgraph exists to do: **workflows that get measurably
better at their job across runs.**

## What it does

Runs the same research-brief task over 5 different topics, twice:

| Condition | Graph | Memory |
|---|---|---|
| **learning** | `research → critique → reflect` | lessons accumulate; each run retrieves all prior lessons via `memoryQuery` |
| **control** | `research` only | none — same agent config, same topics, same order |

The researcher never sees the quality rubric. A critic agent compares each
brief against a fixed rubric and emits **generic, transferable lessons**
("cite named sources with years", "quantify claims"). A `reflection` node
distills those into memory; the next run's researcher prompt includes them
via `memoryQuery`, so run N benefits from the critiques of runs 1..N-1 on
topics it has never seen.

Scoring is **external to the workflow** (the agents never see the scores):

- **structural** — 6 deterministic regex/word-count checks against the
  rubric. Fully reproducible, no LLM trust required.
- **judge** — `@cycgraph/evals` multi-sample LLM-as-judge (3 samples,
  median) on a stronger model than the workers.
- **fitness** = `0.5 × structural + 0.5 × judge`

Because the control condition shares the model, topics, and order, any gap
between the two lines is attributable to the learning loop itself.

## Run it

```bash
# from the repo root
npm install && npm run build
ANTHROPIC_API_KEY=sk-ant-... npx tsx packages/evals/examples/compound-learning-benchmark/compound-learning-benchmark.ts
```

Takes ~5–10 minutes and costs under $1 (10 Sonnet worker runs + 30 Opus
judge calls). Writes `results.json` (full per-run data, every brief, every
judge sample) and `chart.svg` (fitness-per-run, learning vs control) next
to this file.

## What to expect

Run 1 of both conditions scores similarly — the learning workflow has no
lessons yet. From run 2 onward the learning line should climb as lessons
accumulate, while the control line stays flat. `results.json` lets you
verify the mechanism: each learning run records how many lessons were
injected into the researcher's prompt and what the critic added afterwards.
