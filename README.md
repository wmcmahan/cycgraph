<div align="center">

# cycgraph

**A TypeScript engine for cyclic LLM agent workflows with durable execution and cross-run memory.**

[![npm](https://img.shields.io/npm/v/@cycgraph/orchestrator?label=%40cycgraph%2Forchestrator&color=cb3837)](https://www.npmjs.com/package/@cycgraph/orchestrator)
[![CI](https://github.com/wmcmahan/cycgraph/actions/workflows/ci.yml/badge.svg)](https://github.com/wmcmahan/cycgraph/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Docs](https://img.shields.io/badge/docs-flattop.io-3b82f6)](https://flattop.io)

[📚 Documentation](https://flattop.io) &nbsp;·&nbsp; [📈 Compound Learning Benchmark](./packages/evals/examples/compound-learning-benchmark/) &nbsp;·&nbsp; [🧪 Examples](./packages/orchestrator/examples/) &nbsp;·&nbsp; [🐛 Issues](https://github.com/wmcmahan/cycgraph/issues)

</div>

---

**cycgraph** is a TypeScript orchestration engine for cyclic LLM agent workflows — loops, conditional routing, parallel fan-out, and nested subgraphs are native operations. Runs are durable (event-sourced replay, atomic state snapshots) and bounded by production-safety primitives: per-node budgets, zero-trust state slicing, taint tracking, and human-in-the-loop gates. Optional cross-run memory lets a `reflection` node distill lessons from one run that later runs retrieve automatically.

## Safety primitives

First-class node/graph configuration for running agents with guardrails, not middleware:

- **Per-node budgets** — `budget: { max_tokens, max_cost_usd }` on every node. A runaway agent can't drain the workflow.
- **Zero-trust state slicing** — `read_keys` / `write_keys` default to `[]`; every node sees only what it declares. The engine rejects undeclared writes.
- **Taint tracking** — every string from an external MCP tool is flagged in an append-only registry and propagates through derived values; strict mode rejects tainted data in routing conditions.
- **Fact sanitization** — a `factSanitizer` hook screens every reflection fact before it persists (PII redaction, policy filtering); fails closed by default.
- **Eval-gated retention (verified lessons)** — lessons enter on trial and are kept only if runs that used them verifiably scored better; harmful ones are evicted on outcome evidence alone. In the [adversarial demo](./packages/evals/examples/eval-gated-learning/), three deliberately poisoned lessons cratered a run and the gate evicted all three two runs later — no human touched the store.
- **Human-in-the-loop gates** — pause for approval and resume hours later from the exact checkpoint, surviving process restarts.
- **MCP server registry** — stdio transports restricted to an allowlist, http/sse URLs SSRF-guarded, schemas re-validated on every read/write.

## Built-in patterns

Each pattern is a node type. Declarative, composable, and traced through OpenTelemetry.

| Pattern | Use it when |
|---|---|
| **[Reflection](https://flattop.io/patterns/reflection/)** | Distill run output into atomic facts that future runs retrieve |
| **[Evolution (DGM)](https://flattop.io/patterns/evolution/)** | Generate N candidates per generation, score fitness, breed the winners |
| **[Supervisor](https://flattop.io/patterns/supervisor/)** | An LLM decides which specialist worker should run next, iteratively |
| **[Swarm](https://flattop.io/patterns/swarm/)** | Peer agents hand off work to each other based on competence |
| **[Map-Reduce](https://flattop.io/patterns/map-reduce/)** | Fan out an array of items to parallel workers, then merge |
| **[Self-Annealing](https://flattop.io/patterns/self-annealing/)** | Iteratively refine a single output, dropping temperature each pass |
| **[Human-in-the-Loop](https://flattop.io/patterns/human-in-the-loop/)** | Pause for a human reviewer; resume hours later from the exact checkpoint |

Plus deterministic primitives: `verifier` (LLM-judge / filtrex expression / JSONPath assertion), `voting` (consensus across N voter agents), `subgraph` (nested workflows with isolated state).

## What you get

- **Cyclic graph engine** — loops, retries, conditional routing via [filtrex](https://github.com/joewalnes/filtrex), nested subgraphs, parallel fan-out/fan-in. **12 node types** — see the [Nodes reference](https://flattop.io/concepts/nodes/).
- **Durable execution** — event-sourced replay, atomic state snapshots, saga compensation, auto-compaction.
- **Production-safety primitives** — per-node `budget`, `factSanitizer` for PII redaction, taint tracking, zero-trust `read_keys`/`write_keys`, prompt-injection guards.
- **Distributed execution** — `WorkflowWorker` + durable job queue for multi-process deployments, with crash recovery and run fencing (a reclaimed worker can't clobber the new owner).
- **Streaming** — `stream()` async generator with real-time token deltas, tool-call events, and typed lifecycle events.
- **MCP tools** — built-in default servers (web search, fetch), tool manifest caching, per-tool circuit breakers.
- **Observability** — 17 lifecycle events, OpenTelemetry spans, Prometheus metrics, per-agent + per-workflow token/cost tracking.
- **Cross-run memory** — `reflection` node distills run output into atomic facts; future runs retrieve them via `memory_query` on any agent node. Backed by a temporal knowledge graph in `@cycgraph/memory`.

## Quick start

**In your project:**

```bash
npm install @cycgraph/orchestrator
```

**Try a runnable example first (no project needed):**

```bash
git clone https://github.com/wmcmahan/cycgraph.git && cd cycgraph && npm install
ANTHROPIC_API_KEY=sk-ant-... npx tsx packages/orchestrator/examples/research-and-write/research-and-write.ts
```

See the [Quick Start guide](https://flattop.io/getting-started/quick-start/) for a complete walkthrough. The [`examples/`](./packages/orchestrator/examples/) directory has runnable scripts for every built-in pattern plus infrastructure setups (Postgres, Ollama, MCP) — the table below points at the most commonly searched-for ones.

## Examples by what you're trying to build

- **Proof the learning loop works (with charts)** → [`compound-learning-benchmark`](./packages/evals/examples/compound-learning-benchmark/)
- **A research agent that learns over runs** → [`learning-research-agent`](./packages/orchestrator/examples/learning-research-agent/)
- **Multi-specialist routing** → [`supervisor-routing`](./packages/orchestrator/examples/supervisor-routing/)
- **Quality loop until score ≥ N** → [`eval-loop`](./packages/orchestrator/examples/eval-loop/)
- **Parallel research workers + merge** → [`map-reduce`](./packages/orchestrator/examples/map-reduce/)
- **Verify-and-fix with deterministic gates** → [`verifier-fix-loop`](./packages/orchestrator/examples/verifier-fix-loop/)
- **Voting / consensus across N agents** → [`voting`](./packages/orchestrator/examples/voting/)
- **Evolutionary candidate breeding** → [`evolution`](./packages/orchestrator/examples/evolution/)
- **Pause for human review + resume** → [`human-in-the-loop`](./packages/orchestrator/examples/human-in-the-loop/)
- **MCP tools (web search, fetch)** → [`mcp-integration`](./packages/orchestrator/examples/mcp-integration/)
- **Local Ollama models** → [`ollama-local`](./packages/orchestrator/examples/ollama-local/)
- **Postgres durable execution** → [`postgres-persistence`](./packages/orchestrator/examples/postgres-persistence/)

## Packages

| Package | What it does |
|---|---|
| [`@cycgraph/orchestrator`](./packages/orchestrator) | Core graph engine. Zero infrastructure dependencies. |
| [`@cycgraph/memory`](./packages/memory) | Temporal knowledge graph + xMemory-inspired hierarchical retrieval (messages → episodes → facts → themes). |
| [`@cycgraph/context-engine`](./packages/context-engine) | Optional prompt compression pipeline — strips redundant facts, verbose serialisation, and stale reasoning traces from memory payloads. |
| [`@cycgraph/orchestrator-postgres`](./packages/orchestrator-postgres) | Postgres + pgvector adapter for durable state, event log, agent registry, and memory store. |
| [`@cycgraph/evals`](./packages/evals) | Regression-test harness for agent workflows with deterministic + LLM-as-judge assertions. |

## Documentation

The full documentation site lives at **[flattop.io](https://flattop.io)**:

- **[Quick Start](https://flattop.io/getting-started/quick-start/)** — your first workflow in 5 minutes
- **[Core Concepts](https://flattop.io/concepts/overview/)** — graphs, nodes, agents, state
- **[Patterns](https://flattop.io/patterns/supervisor/)** — runnable guides for each built-in pattern
- **[Troubleshooting](https://flattop.io/getting-started/troubleshooting/)** — common errors, fixes, and the gotchas that fail silently

## Contributing

Issues and PRs welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, coding standards, and the architecture decisions worth knowing before opening a PR. Security disclosures go through [SECURITY.md](SECURITY.md).

## License

[Apache 2.0](LICENSE).
