<div align="center">

# CYCGRAPH

**An engine for running cyclic LLM agent workflows.**

[![npm](https://img.shields.io/npm/v/@cycgraph/orchestrator?label=%40cycgraph%2Forchestrator&color=cb3837)](https://www.npmjs.com/package/@cycgraph/orchestrator)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Docs](https://img.shields.io/badge/docs-flattop.io-3b82f6)](https://flattop.io/docs/)

</div>

---

**CYCGRAPH** is an orchestration engine for running cyclic LLM agent workflows — loops, conditional routing, parallel fan-out, and nested subgraphs. See [flattop.io](https://flattop.io/docs/) for full docs.

- **[Quick Start](https://flattop.io/docs/getting-started/quick-start/)** — your first workflow in 5 minutes
- **[Core Concepts](https://flattop.io/docs/concepts/overview/)** — graphs, nodes, agents, state
- **[Patterns](https://flattop.io/docs/patterns/supervisor/)** — runnable guides for each built-in pattern
- **[Troubleshooting](https://flattop.io/docs/getting-started/troubleshooting/)** — common errors, fixes, and the gotchas that fail silently
- **[Examples](./packages/orchestrator/examples/)** - runnable examples for each built-in pattern and infrastructure setup

## Install

See the [Quick Start guide](https://flattop.io/docs/getting-started/quick-start/) for a complete walkthrough.

```bash
npm install @cycgraph/orchestrator
```

**Optional packages**

- [@cycgraph/memory](https://github.com/wmcmahan/cycgraph/blob/main/packages/memory) - Temporal knowledge graph + xMemory-inspired hierarchical retrieval (messages → episodes → facts → themes).
- [@cycgraph/context-engine](https://github.com/wmcmahan/cycgraph/blob/main/packages/context-engine) - Optional prompt compression pipeline — strips redundant facts, verbose serialisation, and stale reasoning traces from memory payloads.
- [@cycgraph/orchestrator-postgres](https://github.com/wmcmahan/cycgraph/blob/main/packages/orchestrator-postgres) - Postgres + pgvector adapter for durable state, event log, agent registry, and memory store.
- [@cycgraph/evals](https://github.com/wmcmahan/cycgraph/blob/main/packages/evals) - Regression-test harness for agent workflows with deterministic + LLM-as-judge assertions.

## Built-in Patterns

Each pattern is a node type. Declarative, composable, and traced through OpenTelemetry.

- **[Reflection](https://flattop.io/docs/patterns/reflection/)** Distill run output into atomic facts that future runs retrieve
- **[Evolution (DGM)](https://flattop.io/docs/patterns/evolution/)** Generate N candidates per generation, score fitness, breed the winners
- **[Supervisor](https://flattop.io/docs/patterns/supervisor/)** An LLM decides which specialist worker should run next, iteratively
- **[Swarm](https://flattop.io/docs/patterns/swarm/)** Peer agents hand off work to each other based on competence
- **[Map-Reduce](https://flattop.io/docs/patterns/map-reduce/)** Fan out an array of items to parallel workers, then merge
- **[Self-Annealing](https://flattop.io/docs/patterns/self-annealing/)** Iteratively refine a single output, dropping temperature each pass
- **[Human-in-the-Loop](https://flattop.io/docs/patterns/human-in-the-loop/)** Pause for a human reviewer; resume hours later from the exact checkpoint
- **[Verifier](https://flattop.io/docs/patterns/verifier/)** LLM-judge / filtrex expression / JSONPath assertion
- **[Voting](https://flattop.io/docs/patterns/voting/)** consensus across N voter agents
- **[Subgraph](https://flattop.io/docs/patterns/subgraph/)** nested workflows with isolated state

## Examples

- [**Proof the learning loop works (with charts)**](https://github.com/wmcmahan/cycgraph/blob/main/packages/evals/examples/compound-learning-benchmark/)
- [**A research agent that learns over runs**](https://github.com/wmcmahan/cycgraph/blob/main/packages/orchestrator/examples/learning-research-agent/)
- [**Multi-specialist routing**](https://github.com/wmcmahan/cycgraph/blob/main/packages/orchestrator/examples/supervisor-routing/)
- [**Quality loop until score ≥ N**](https://github.com/wmcmahan/cycgraph/blob/main/packages/orchestrator/examples/eval-loop/)
- [**Parallel research workers + merge**](https://github.com/wmcmahan/cycgraph/blob/main/packages/orchestrator/examples/map-reduce/)
- [**Verify-and-fix with deterministic gates**](https://github.com/wmcmahan/cycgraph/blob/main/packages/orchestrator/examples/verifier-fix-loop/)
- [**Voting / consensus across N agents**](https://github.com/wmcmahan/cycgraph/blob/main/packages/orchestrator/examples/voting/)
- [**Evolutionary candidate breeding**](./packages/orchestrator/examples/evolution/)
- [**Pause for human review + resume**](https://github.com/wmcmahan/cycgraph/blob/main/packages/orchestrator/examples/human-in-the-loop/)
- [**MCP tools (web search, fetch)**](https://github.com/wmcmahan/cycgraph/blob/main/packages/orchestrator/examples/mcp-integration/)
- [**Local Ollama models**](https://github.com/wmcmahan/cycgraph/blob/main/packages/orchestrator/examples/ollama-local/)
- [**Postgres durable execution**](https://github.com/wmcmahan/cycgraph/blob/main/packages/orchestrator/examples/postgres-persistence/)

## Safety

Node and graph configuration for running agents with guardrails.

- **Per-node budgets** — set limits per node on cost, tokens, or tool calls. A runaway agent can't drain the workflow.
- **Zero-trust state slicing** — every node sees only what it declares. The engine rejects undeclared writes.
- **Taint tracking** — every string from an external MCP tool is flagged in an append-only registry and propagates through derived values; strict mode rejects tainted data in routing conditions.
- **Fact sanitization** — hook screens every reflection fact before it persists (PII redaction, policy filtering); fails closed by default.
- **Eval-gated retention** — lessons enter on trial and are kept only if runs that used them verifiably scored better; harmful ones are evicted on outcome evidence alone.
- **Human-in-the-loop gates** — pause for approval and resume hours later from the exact checkpoint, surviving process restarts.
- **MCP server registry** — stdio transports restricted to an allowlist, http/sse URLs SSRF-guarded, schemas re-validated on every read/write.

## Contributing

Issues and PRs welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, coding standards, and the architecture decisions worth knowing before opening a PR. Security disclosures go through [SECURITY.md](SECURITY.md).

## License

[Apache 2.0](LICENSE).
