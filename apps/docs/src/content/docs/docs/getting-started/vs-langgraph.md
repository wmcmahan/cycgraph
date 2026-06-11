---
title: cycgraph vs LangGraph
description: An honest comparison — where LangGraph is the better choice, where cycgraph is, and the architectural difference that actually matters.
---

LangGraph is the most established graph-based agent framework, and for many teams it's the right choice. This page is an honest comparison, not a takedown — both frameworks model agent workflows as stateful graphs with cycles, checkpointing, and human-in-the-loop interrupts. The differences that matter are in **what ships as a first-class primitive versus what you wire yourself**.

*Last reviewed June 2026. LangGraph moves fast — if something here is outdated, [open an issue](https://github.com/wmcmahan/cycgraph/issues).*

## The short version

**Choose LangGraph when** you're in a Python-first organization, you want the largest ecosystem of integrations and community answers, you're already invested in LangSmith for observability, or you want a managed platform (LangGraph Platform) to run agents for you.

**Choose cycgraph when** you want workflows that measurably improve across runs without building the learning loop yourself, you need security primitives (taint tracking, least-privilege state slicing, per-node budgets) as engine guarantees rather than application code, or you're TypeScript-first and want Zod-validated boundaries instead of a port from Python.

## The difference that actually matters: the learning loop

Both frameworks can persist memory across runs. The difference is what the framework does with it.

**LangGraph** gives you a `Store` interface — cross-thread key-value memory with semantic search. It's a solid primitive, but the loop is yours to build: you decide when to write memories, what to distill, how to retrieve them, and how to inject them into prompts.

**cycgraph** ships the closed loop as node configuration:

- A `reflection` node distills any run output into atomic, tagged facts — rule-based (free, deterministic) or LLM-extracted.
- A `factSanitizer` hook screens every fact before persistence (PII redaction, policy filtering), failing closed by default.
- Any node carrying a `memory_query` directive gets matching facts rendered into its prompt automatically before execution.

No glue code, and the loop is **measured**: the [compound-learning benchmark](https://github.com/wmcmahan/cycgraph/tree/main/packages/evals/examples/compound-learning-benchmark) runs the same workflow with and without the loop over five unseen topics. In our first recorded run the learning workflow climbed from 0.00 to 1.00 fitness while the identical no-learning control averaged 0.18. It costs under $1 to reproduce.

## Security posture

This is the second structural difference. In cycgraph these are engine-enforced, not middleware:

- **State slicing** — every node declares `read_keys` / `write_keys`, defaulting to `[]`. A node cannot read state it didn't declare, and the engine rejects undeclared writes. In LangGraph, all nodes share the full state object (channel-level reducers control writes, but reads are open).
- **Taint tracking** — every string returned by an external MCP tool is flagged in an append-only registry and propagates to derived values; strict mode rejects tainted data in routing conditions. LangGraph has no equivalent — prompt-injection defense is application code.
- **Per-node budgets** — `budget: { max_tokens, max_cost_usd }` on any node throws `NodeBudgetExceededError` before a runaway agent drains the workflow. LangGraph tracks usage via callbacks; enforcement is yours.
- **MCP server registry** — stdio transports restricted to an executable allowlist, http/sse URLs SSRF-guarded, configs re-validated on every read/write.

## Feature comparison

| | cycgraph | LangGraph |
|---|---|---|
| Cyclic graphs, conditional routing | ✅ | ✅ |
| Durable execution / checkpointing | ✅ event-sourced replay + Postgres adapter, run fencing | ✅ checkpointers (SQLite/Postgres) + LangGraph Platform |
| Human-in-the-loop | ✅ pause/resume surviving restarts | ✅ interrupts |
| Cross-run memory | ✅ temporal knowledge graph, **automatic reflection → retrieval loop** | ✅ `Store` API — loop is yours to build |
| Measured learning benchmark | ✅ [reproducible, in-repo](https://github.com/wmcmahan/cycgraph/tree/main/packages/evals/examples/compound-learning-benchmark) | — |
| Eval-gated lesson retention | ✅ lessons promoted/evicted on run-outcome evidence ([adversarial demo](https://github.com/wmcmahan/cycgraph/tree/main/packages/evals/examples/eval-gated-learning)) | — |
| Per-node cost/token budgets | ✅ engine-enforced | manual (callbacks) |
| Taint tracking on external data | ✅ | — |
| Least-privilege state access | ✅ `read_keys`/`write_keys`, default deny | shared state, reducer-gated writes |
| Population-based evolution (DGM) | ✅ built-in node type | build it yourself |
| Voting / verifier / swarm / annealing | ✅ built-in node types | build it yourself |
| Workflow generation from natural language | ✅ Architect (validated against schema, HITL-gated publish) | — |
| Language | TypeScript-first (Zod everywhere) | Python-first, JS port |
| Tool ecosystem | MCP-native | LangChain integrations (largest ecosystem) + MCP adapters |
| Observability | OpenTelemetry + Prometheus (open standards) | LangSmith (excellent, commercial) |
| Managed platform | — (self-host) | ✅ LangGraph Platform |
| Community size | small (early) | very large |

## What LangGraph does better today

Worth being explicit about: LangGraph has years of production hardening, an enormous integration catalog through the LangChain ecosystem, first-party Python support, a managed deployment platform, and a community large enough that most questions are already answered on Stack Overflow. cycgraph is at `0.1.0-beta` with 2,100+ tests and runnable examples for every pattern — solid foundations, small community. If ecosystem maturity is your top criterion, LangGraph is the safer pick today.

## Try the difference

The fastest way to evaluate the claim that matters — measurable self-improvement — is to run the benchmark:

```bash
git clone https://github.com/wmcmahan/cycgraph.git && cd cycgraph && npm install && npm run build
ANTHROPIC_API_KEY=sk-ant-... npx tsx packages/evals/examples/compound-learning-benchmark/compound-learning-benchmark.ts
```

Five learning runs, five control runs, a chart, and every brief and judge sample written to `results.json` so you can audit the scoring yourself.
