# @cycgraph/benchmarks

Performance benchmarks for the cycgraph orchestrator. **Private — never published.**

## Why this exists

Until now the perf claims in the docs ("handles 1000-node graphs", "streaming has acceptable overhead") were unverified. This package pins them.

The benchmarks isolate three layers:

| Layer | What we measure | Why |
| --- | --- | --- |
| **Reducer** (`reducer.bench.ts`) | Pure-CPU action application | Fires millions of times in a heavy workflow. Regression here is amplified everywhere. |
| **GraphRunner** (`graph-runner-scaling.bench.ts`) | End-to-end `run()` + `stream()` on N-node graphs | Confirms scaling claims, exposes overhead between `run()` and `stream()`. |
| **StreamChannel** (`stream-channel.bench.ts`) | Pending queue, token channel, notify wake-up | Hot path of every `stream()` consumer. |

No LLM is involved — every graph uses the built-in `save_to_memory` tool, so what we're measuring is pure orchestration overhead.

## How to run

```bash
# From the repo root:
npm run bench

# Or from this package:
cd packages/benchmarks
npm run bench           # one-shot
npm run bench:watch     # interactive
```

Each `.bench.ts` file emits per-bench ops/sec, mean time, and standard deviation. Vitest's default reporter prints a table to stdout — pipe to a file if you want a baseline:

```bash
npm run bench 2>&1 | tee bench-results-$(date +%Y%m%d).txt
```

## How to interpret

These are **order-of-magnitude signals, not contractual SLAs**. The runner is JS — its absolute numbers are dwarfed by anything that calls an LLM. What you're watching for:

- **Slope, not absolute values.** Going from 10 → 100 → 1000 nodes should look roughly linear. A super-linear blow-up means a routine got accidentally quadratic.
- **`run()` vs `stream()` on the same graph.** Streaming should add overhead but not double the time. A widening gap means the channel or notify path regressed.
- **Sustained-load benches** (e.g. "100 sequential update_memory calls") catch memory-bound regressions that single-shot benches miss.

Baselines captured on a 2024 Mac (M-series, Node 22, no thermal throttling):

| Bench | Measured | Implication |
| --- | --- | --- |
| `rootReducer — tiny value` | ~2.5M ops/sec | Reducer not a bottleneck |
| `rootReducer — 1000-element array` | ~135K ops/sec | 18× slower than tiny — JSON serialization cost dominates |
| `internalReducer — _track_tokens` | ~12M ops/sec | Internal dispatch is essentially free |
| `merge_parallel_results — 2 keys` | ~1.7M ops/sec | Fan-in merge fast at typical widths |
| `merge_parallel_results — 50 keys` | ~118K ops/sec | 15× slower — scales with key count |
| `10-node linear run()` | ~11.7K runs/sec | ~85µs per node |
| `100-node linear run()` | ~725 runs/sec | ~14µs per node (amortizes setup) |
| `1000-node linear run()` | ~9.6 runs/sec | ~104ms wall-clock — confirms linear scaling |
| `100-node stream() vs run()` | 8% overhead | Streaming mode is essentially free |
| `StreamChannel push 1000 tokens + drain` | ~16K cycles/sec | Token channel never bottlenecks |
| `StreamChannel waitForNotify + notify (1000 cycles)` | ~34K cycles/sec | Async notify ~30µs per cycle |

If your machine is faster or slower, take a baseline before changing anything and compare deltas — not absolutes.

## Not in CI

Shared CI runners are too noisy for benchmarks. The package is excluded from the default `npm test` invocation (it has no `test` script — only `bench`). Run locally before merging anything that touches the runner, reducer, or channel.

## Adding a new bench

1. Drop a `*.bench.ts` file in `src/`. The `vitest.config.ts` glob picks it up automatically.
2. Group related cases with `describe(...)`. Vitest formats them as a single table.
3. Don't share mutable state between iterations — `vitest bench` runs each `bench(...)` body many times in a tight loop.
4. For expensive scenarios (1000+ iterations of internal loops), pass `{ iterations: 5 }` so the bench doesn't run for minutes.
5. Update the **interpret** table above if your new bench has a useful order-of-magnitude expectation.

## What this DOES NOT measure

- **LLM latency** — agents are out of scope; provider performance is the upstream problem.
- **Persistence backend** — every bench uses in-memory persistence. Postgres throughput is the adapter's responsibility.
- **MCP tool execution** — tool nodes use the in-process `save_to_memory` builtin to keep the runner overhead isolated.
- **Memory index search** — no pgvector adapter ships yet. When it does, add a bench here.
