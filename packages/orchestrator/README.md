<div align="center">

# @cycgraph/orchestrator

**The core engine of cycgraph — a TypeScript agent orchestrator built on a Cyclic State Graph.**

[![npm](https://img.shields.io/npm/v/@cycgraph/orchestrator?label=%40cycgraph%2Forchestrator&color=cb3837)](https://www.npmjs.com/package/@cycgraph/orchestrator)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Docs](https://img.shields.io/badge/docs-flattop.io-3b82f6)](https://flattop.io/docs)

</div>

---

Define multi-step agent workflows declaratively, run them with durable execution, and let them **distill what they learned** into a persistent knowledge store that future runs retrieve automatically. Cyclic loops, dynamic supervisors, population-based evolution, and human-in-the-loop gates ship as first-class node types, not framework extensions.

- **[Quick Start](https://flattop.io/docs/getting-started/quick-start/)** — your first workflow in 5 minutes
- **[Core Concepts](https://flattop.io/docs/concepts/overview/)** — graphs, nodes, agents, state, memory
- **[Patterns](https://flattop.io/docs/patterns/supervisor/)** — runnable guides for each built-in pattern
- **[Troubleshooting](https://flattop.io/docs/getting-started/troubleshooting/)** — common errors, fixes, and the gotchas that fail silently
- **[Operations / Deployment](https://flattop.io/docs/operations/deployment/)** — durable persistence, distributed execution, monitoring

## Install

See the [Quick Start guide](https://flattop.io/docs/getting-started/quick-start/) for a complete walkthrough.

```bash
npm install @cycgraph/orchestrator
```

**Optional packages**

- [@cycgraph/memory](./packages/memory) - Temporal knowledge graph + xMemory-inspired hierarchical retrieval (messages → episodes → facts → themes).
- [@cycgraph/context-engine](./packages/context-engine) - Optional prompt compression pipeline — strips redundant facts, verbose serialisation, and stale reasoning traces from memory payloads.
- [@cycgraph/orchestrator-postgres](./packages/orchestrator-postgres) - Postgres + pgvector adapter for durable state, event log, agent registry, and memory store.
- [@cycgraph/evals](./packages/evals) - Regression-test harness for agent workflows with deterministic + LLM-as-judge assertions.

## Built-in Patterns

Each pattern is a node type. Declarative, composable, and traced through OpenTelemetry.

- **[Supervisor](https://flattop.io/docs/patterns/supervisor/)** An LLM decides which specialist worker should run next, iteratively
- **[Swarm](https://flattop.io/docs/patterns/swarm/)** Peer agents hand off work to each other based on competence
- **[Map-Reduce](https://flattop.io/docs/patterns/map-reduce/)** Fan out an array of items to parallel workers, then merge
- **[Evolution (DGM)](https://flattop.io/docs/patterns/evolution/)** Generate N candidates per generation, score fitness, breed the winners
- **[Self-Annealing](https://flattop.io/docs/patterns/self-annealing/)** Iteratively refine a single output, dropping temperature each pass
- **[Reflection](https://flattop.io/docs/patterns/reflection/)** Distill run output into atomic facts that future runs retrieve
- **[Human-in-the-Loop](https://flattop.io/docs/patterns/human-in-the-loop/)** | Pause for a human reviewer; resume hours later from the exact checkpoint
- **[Verifier](https://flattop.io/docs/patterns/verifier/)** LLM-judge / filtrex expression / JSONPath assertion
- **[Voting](https://flattop.io/docs/patterns/voting/)** consensus across N voter agents
- **[Subgraph](https://flattop.io/docs/concepts/nodes/#subgraphconfig)** nested workflows with isolated state

## Examples

- [**Proof the learning loop works (with charts)**](https://github.com/wmcmahan/cycgraph/blob/main/packages/evals/examples/compound-learning-benchmark/)
- [**A research agent that learns over runs**](https://github.com/wmcmahan/cycgraph/blob/main/packages/orchestrator/examples/learning-research-agent/)
- [**Multi-specialist routing**](https://github.com/wmcmahan/cycgraph/blob/main/packages/orchestrator/examples/supervisor-routing/)
- [**Quality loop until score ≥ N**](https://github.com/wmcmahan/cycgraph/blob/main/packages/orchestrator/examples/eval-loop/)
- [**Parallel research workers + merge**](https://github.com/wmcmahan/cycgraph/blob/main/packages/orchestrator/examples/map-reduce/)
- [**Verify-and-fix with deterministic gates**](https://github.com/wmcmahan/cycgraph/blob/main/packages/orchestrator/examples/verifier-fix-loop/)
- [**Voting / consensus across N agents**](https://github.com/wmcmahan/cycgraph/blob/main/packages/orchestrator/examples/voting/)
- [**Evolutionary candidate breeding**](https://github.com/wmcmahan/cycgraph/blob/main/packages/orchestrator/examples/evolution/)
- [**Pause for human review + resume**](https://github.com/wmcmahan/cycgraph/blob/main/packages/orchestrator/examples/human-in-the-loop/)
- [**MCP tools (web search, fetch)**](https://github.com/wmcmahan/cycgraph/blob/main/packages/orchestrator/examples/mcp-integration/)
- [**Local Ollama models**](https://github.com/wmcmahan/cycgraph/blob/main/packages/orchestrator/examples/ollama-local/)
- [**Postgres durable execution**](https://github.com/wmcmahan/cycgraph/blob/main/packages/orchestrator/examples/postgres-persistence/)

## Contributing

Issues and PRs welcome. See [CONTRIBUTING.md](https://github.com/wmcmahan/cycgraph/blob/main/CONTRIBUTING.md) for development setup, coding standards, and the architecture decisions worth knowing before opening a PR. Security disclosures go through [SECURITY.md](https://github.com/wmcmahan/cycgraph/blob/main/SECURITY.md).

## License

[Apache 2.0](https://github.com/wmcmahan/cycgraph/blob/main/LICENSE).