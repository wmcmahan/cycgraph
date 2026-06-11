<div align="center">

# cycgraph

[![npm](https://img.shields.io/npm/v/@cycgraph/orchestrator?label=%40cycgraph%2Forchestrator&color=cb3837)](https://www.npmjs.com/package/@cycgraph/orchestrator)
[![CI](https://github.com/wmcmahan/cycgraph/actions/workflows/ci.yml/badge.svg)](https://github.com/wmcmahan/cycgraph/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D24-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Docs](https://img.shields.io/badge/docs-flattop.io-3b82f6)](https://flattop.io)

[📚 Documentation](https://flattop.io) &nbsp;·&nbsp; [🧪 Examples](./packages/orchestrator/examples/) &nbsp;·&nbsp; [🪞 Compound Learning Demo](./packages/orchestrator/examples/learning-research-agent/) &nbsp;·&nbsp; [🐛 Issues](https://github.com/wmcmahan/cycgraph/issues)

</div>

---

> **Status:** `0.1.0-beta`. The API is stabilising; minor versions may still introduce breaking changes until 1.0. Core primitives (graph engine, durable execution, memory, MCP integration) are covered by 2,100+ tests and exercised by the runnable examples.

cycgraph is an agent orchestration engine built on a **Cyclic State Graph**. Define multi-step agent workflows declaratively, run them with durable execution, and let them **distill what they learned** into a persistent knowledge store that future runs retrieve automatically. Cyclic loops, dynamic supervisors, population-based evolution, and human-in-the-loop gates ship as first-class node types, not framework extensions.

## What makes cycgraph different

| | cycgraph | Most agent frameworks |
|---|---|---|
| **Compound learning across runs** | First-class `reflection` node + `MemoryWriter` + tag-scoped retrieval. Agents that ran yesterday inform agents that run today. | Usually a separate vector-store integration you wire yourself |
| **Per-node resource budgets** | `budget: { max_tokens, max_cost_usd }` on every node. A runaway agent can't drain the workflow. | Typically workflow-wide caps |
| **Zero-trust state slicing** | Every node declares `read_keys` / `write_keys`. Taint tracking on external data, MCP server allowlists, prompt-injection guards. | Often middleware or hand-wired |
| **Cyclic by design** | Loops, conditional routing, and nested subgraphs are native operations — not a DAG with backward-pointing edges bolted on. | DAG-shaped with workarounds |
| **TypeScript-first** | Zod schemas at every boundary, strict mode throughout, MCP-native tool integration. | Mostly Python ecosystems with TS as a port |
| **Durable execution** | Event-sourced replay, atomic state snapshots, saga compensation, HITL pauses that survive process restarts. | Varies by framework |

## What it looks like

A two-node graph — an agent that researches and a `reflection` node that distills its notes into a memory store. Run the same graph twice on related goals and **run 2's prompt automatically contains what run 1 learned**.

```typescript
import { GraphRunner, createGraph, createWorkflowState } from '@cycgraph/orchestrator';

const graph = createGraph({
  name: 'Learning Research Agent',
  description: 'Researches a topic, reflects on lessons, compounds across runs',
  nodes: [
    {
      id: 'research',
      type: 'agent',
      agent_id: RESEARCHER,
      read_keys: ['goal'],
      write_keys: ['notes'],
      memory_query: { tags: ['lesson:research-v1'], max_facts: 20 },
      budget: { max_cost_usd: 0.10 },
    },
    {
      id: 'reflect',
      type: 'reflection',
      read_keys: ['notes'],
      write_keys: ['reflection'],
      reflection_config: {
        source_keys: ['notes'],
        extractor: { type: 'rule_based', min_sentence_length: 25 },
        tags: ['lesson', 'lesson:research-v1'],
      },
    },
  ],
  edges: [{ source: 'research', target: 'reflect' }],
  start_node: 'research',
  end_nodes: ['reflect'],
});

const runner = (goal: string) => new GraphRunner(
  graph,
  createWorkflowState({ workflow_id: graph.id, goal }),
  { memoryWriter, memoryRetriever },
);

await runner('Evaluating scientific source credibility').run();
await runner('Evaluating news source credibility').run();
```

Full runnable version — including the agent registration, memory adapters, and side-by-side run-1 vs run-2 stats — is in [`examples/learning-research-agent`](./packages/orchestrator/examples/learning-research-agent/).

## Built-in patterns

Each pattern is a node type. Declarative, composable, and traced through OpenTelemetry.

| Pattern | Use it when |
|---|---|
| **[Supervisor](https://flattop.io/patterns/supervisor/)** | An LLM decides which specialist worker should run next, iteratively |
| **[Swarm](https://flattop.io/patterns/swarm/)** | Peer agents hand off work to each other based on competence |
| **[Map-Reduce](https://flattop.io/patterns/map-reduce/)** | Fan out an array of items to parallel workers, then merge |
| **[Evolution (DGM)](https://flattop.io/patterns/evolution/)** | Generate N candidates per generation, score fitness, breed the winners |
| **[Self-Annealing](https://flattop.io/patterns/self-annealing/)** | Iteratively refine a single output, dropping temperature each pass |
| **[Reflection](https://flattop.io/patterns/reflection/)** | Distill run output into atomic facts that future runs retrieve |
| **[Human-in-the-Loop](https://flattop.io/patterns/human-in-the-loop/)** | Pause for a human reviewer; resume hours later from the exact checkpoint |

Plus deterministic primitives: `verifier` (LLM-judge / filtrex expression / JSONPath assertion), `voting` (consensus across N voter agents), `subgraph` (nested workflows with isolated state).

## What you get

- **Cyclic graph engine** — loops, retries, conditional routing via [filtrex](https://github.com/joewalnes/filtrex), nested subgraphs, parallel fan-out/fan-in.
- **12 node types** — see the [Nodes reference](https://flattop.io/concepts/nodes/).
- **Compound learning across runs** — `reflection` node distills run output into atomic facts; future runs retrieve them via `memory_query` on any agent node. Backed by a temporal knowledge graph in `@cycgraph/memory`.
- **Production-safety primitives** — per-node `budget`, `factSanitizer` for PII redaction, taint tracking, zero-trust `read_keys`/`write_keys`, prompt-injection guards.
- **Durable execution** — event-sourced replay, atomic state snapshots, saga compensation, auto-compaction.
- **Streaming** — `stream()` async generator with real-time token deltas, tool-call events, and typed lifecycle events.
- **MCP tools** — built-in default servers (web search, fetch), tool manifest caching, per-tool circuit breakers.
- **Observability** — 17 lifecycle events, OpenTelemetry spans, Prometheus metrics, per-agent + per-workflow token/cost tracking.
- **Distributed execution** — `WorkflowWorker` + durable job queue for multi-process deployments, with crash recovery and run fencing (a reclaimed worker can't clobber the new owner).

## Quick start

**In your project:**

```bash
npm install @cycgraph/orchestrator
```

**Try a runnable example first (no project needed):**

```bash
git clone https://github.com/wmcmahan/cycgraph.git && cd mc-ai && npm install
ANTHROPIC_API_KEY=sk-ant-... npx tsx packages/orchestrator/examples/research-and-write/research-and-write.ts
```

See the [Quick Start guide](https://flattop.io/getting-started/quick-start/) for a complete walkthrough. The [`examples/`](./packages/orchestrator/examples/) directory has runnable scripts for every built-in pattern plus infrastructure setups (Postgres, Ollama, MCP) — the table below points at the most commonly searched-for ones.

## Examples by what you're trying to build

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