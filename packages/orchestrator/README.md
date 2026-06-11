<div align="center">

# @cycgraph/orchestrator

**The core engine of cycgraph — a TypeScript agent orchestrator built on a Cyclic State Graph.**

[![npm](https://img.shields.io/npm/v/@cycgraph/orchestrator?color=cb3837)](https://www.npmjs.com/package/@cycgraph/orchestrator)
[![CI](https://github.com/wmcmahan/cycgraph/actions/workflows/ci.yml/badge.svg)](https://github.com/wmcmahan/cycgraph/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](../../LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D24-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Docs](https://img.shields.io/badge/docs-flattop.io-3b82f6)](https://flattop.io)

[📚 Documentation](https://flattop.io) &nbsp;·&nbsp; [🧪 Examples](./examples/) &nbsp;·&nbsp; [🪞 Compound Learning Demo](./examples/learning-research-agent/) &nbsp;·&nbsp; [🐛 Issues](https://github.com/wmcmahan/cycgraph/issues)

</div>

---

> **Status:** `0.1.0-beta`. The API is stabilising; minor versions may still introduce breaking changes until 1.0. Core primitives (graph engine, durable execution, memory, MCP integration) are covered by 2,100+ tests and exercised by the runnable examples.

Define multi-step agent workflows declaratively, run them with durable execution, and let them **distill what they learned** into a persistent knowledge store that future runs retrieve automatically. Cyclic loops, dynamic supervisors, population-based evolution, and human-in-the-loop gates ship as first-class node types, not framework extensions.

## What you get in this package

`@cycgraph/orchestrator` is the **standalone graph engine**. Zero infrastructure dependencies — runs entirely in-memory by default. Pair it with [`@cycgraph/memory`](https://www.npmjs.com/package/@cycgraph/memory) for cross-run learning or [`@cycgraph/orchestrator-postgres`](https://www.npmjs.com/package/@cycgraph/orchestrator-postgres) for durable persistence when you need it.

- **Cyclic graph engine** — loops, retries, conditional routing via [filtrex](https://github.com/joewalnes/filtrex), nested subgraphs, parallel fan-out/fan-in.
- **12 node types** — `agent`, `tool`, `router`, `supervisor`, `approval`, `map`, `synthesizer`, `voting`, `subgraph`, `evolution`, `verifier`, `reflection`.
- **Compound learning across runs** — `reflection` node distills run output into atomic facts; future runs retrieve them via `memory_query` on any agent node.
- **Production-safety primitives** — per-node `budget` (token + cost caps), `factSanitizer` for PII redaction, taint tracking on external data, zero-trust `read_keys` / `write_keys`, prompt-injection guards.
- **Durable execution** — event-sourced replay, atomic state snapshots, saga compensation, auto-compaction.
- **Streaming** — `stream()` async generator with real-time token deltas, tool-call events, and typed lifecycle events.
- **MCP-native tools** — built-in default servers (web search, fetch), tool manifest caching, per-tool circuit breakers.
- **Observability** — 17 lifecycle events, OpenTelemetry spans, Prometheus metrics, per-agent + per-workflow token / cost tracking.
- **Distributed execution** — `WorkflowWorker` + durable job queue for multi-process deployments, with crash recovery and run fencing (a reclaimed worker can't clobber the new owner).

## Install

```bash
npm install @cycgraph/orchestrator
```

Both Anthropic and OpenAI are built-in. For Ollama, custom providers, or Groq, see [Custom LLM Providers](https://flattop.io/guides/custom-providers/).

## What it looks like

A two-node graph: an agent that researches, a `reflection` node that distills its notes into a memory store. Run the same graph twice on related goals and **run 2's prompt automatically contains what run 1 learned**.

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
      memory_query: { tags: ['lesson:research-v1'], max_facts: 20 }, // ← retrieves prior lessons
      budget: { max_cost_usd: 0.10 },                                 // ← per-node cost cap
    },
    {
      id: 'reflect',
      type: 'reflection',                                              // ← distills notes → atomic facts
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

Full runnable version with agent registration and memory adapters is in [`examples/learning-research-agent`](./examples/learning-research-agent/).

## Built-in patterns

Each pattern is a node type. Declarative, composable, traced through OpenTelemetry.

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

## Streaming

`run()` returns the final state. `stream()` exposes every lifecycle event as it happens, including real-time token deltas.

```typescript
for await (const event of runner.stream()) {
  switch (event.type) {
    case 'agent:token_delta': process.stdout.write(event.token); break;
    case 'tool:call_start': console.log(`\n[${event.tool_name}]`); break;
    case 'node:complete': console.log(`\n  ✓ ${event.node_id}`); break;
    case 'workflow:complete': console.log('\ndone:', event.state.memory); break;
  }
}
```

Terminal events (`workflow:complete`, `workflow:failed`, `workflow:timeout`, `workflow:waiting`) carry the full `WorkflowState`. Use `isTerminalEvent()` to narrow.

## Examples by what you're trying to build

- **A research agent that learns over runs** → [`learning-research-agent`](./examples/learning-research-agent/)
- **Multi-specialist routing** → [`supervisor-routing`](./examples/supervisor-routing/)
- **Quality loop until score ≥ N** → [`eval-loop`](./examples/eval-loop/)
- **Parallel research workers + merge** → [`map-reduce`](./examples/map-reduce/)
- **Verify-and-fix with deterministic gates** → [`verifier-fix-loop`](./examples/verifier-fix-loop/)
- **Voting / consensus across N agents** → [`voting`](./examples/voting/)
- **Evolutionary candidate breeding** → [`evolution`](./examples/evolution/)
- **Pause for human review + resume** → [`human-in-the-loop`](./examples/human-in-the-loop/)
- **MCP tools (web search, fetch)** → [`mcp-integration`](./examples/mcp-integration/)
- **Local Ollama models** → [`ollama-local`](./examples/ollama-local/)
- **Postgres durable execution** → [`postgres-persistence`](./examples/postgres-persistence/)

Run any of them after cloning the repo:

```bash
ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/research-and-write/research-and-write.ts
```

## Companion packages

| Package | What it adds |
|---|---|
| [`@cycgraph/memory`](https://www.npmjs.com/package/@cycgraph/memory) | Temporal knowledge graph + xMemory hierarchical retrieval — the store reflection nodes write to. Works standalone too. |
| [`@cycgraph/context-engine`](https://www.npmjs.com/package/@cycgraph/context-engine) | Composable prompt-compression pipeline. Strips redundant facts, verbose serialisation, and stale reasoning traces. Plug in via `contextCompressor`. |
| [`@cycgraph/orchestrator-postgres`](https://www.npmjs.com/package/@cycgraph/orchestrator-postgres) | Postgres + pgvector adapter — `PersistenceProvider`, `EventLogWriter`, `AgentRegistry`, `MemoryStore`. Drop-in replacements for the in-memory defaults. |
| [`@cycgraph/evals`](https://www.npmjs.com/package/@cycgraph/evals) | Regression-test harness for agent workflows with deterministic + LLM-as-judge assertions. |

## Documentation

- **[Quick Start](https://flattop.io/getting-started/quick-start/)** — your first workflow in 5 minutes
- **[Core Concepts](https://flattop.io/concepts/overview/)** — graphs, nodes, agents, state, memory
- **[Patterns](https://flattop.io/patterns/supervisor/)** — runnable guides for each built-in pattern
- **[Troubleshooting](https://flattop.io/getting-started/troubleshooting/)** — common errors, fixes, and the gotchas that fail silently
- **[Operations / Deployment](https://flattop.io/operations/deployment/)** — durable persistence, distributed execution, monitoring

## Contributing

Issues and PRs welcome on [GitHub](https://github.com/wmcmahan/cycgraph). See [CONTRIBUTING.md](https://github.com/wmcmahan/cycgraph/blob/main/CONTRIBUTING.md) for development setup and the architecture decisions worth knowing before opening a PR.

## License

[Apache 2.0](https://github.com/wmcmahan/cycgraph/blob/main/LICENSE).