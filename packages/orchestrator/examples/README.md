# Examples

Runnable examples for `@cycgraph/orchestrator`.

## Prerequisites

- Node.js 24+
- `ANTHROPIC_API_KEY` environment variable (get one at [console.anthropic.com](https://console.anthropic.com))

> To use OpenAI instead, change `provider` to `'openai'`, update the `model` field (e.g. `'gpt-4o'`), and set `OPENAI_API_KEY`. Both providers are built-in. For other providers (Groq, Ollama, Mistral, etc.), register them via `ProviderRegistry` — see the [Custom LLM Providers](../README.md#custom-llm-providers) section.

## Available Examples

### Core patterns

| Example | Pattern | Description |
|---------|---------|-------------|
| [research-and-write](./research-and-write/) | Linear | 2-node pipeline: Researcher gathers notes, Writer produces a polished summary |
| [supervisor-routing](./supervisor-routing/) | Supervisor | 4-node cyclic hub-and-spoke: Supervisor dynamically routes between Research, Write, and Edit specialists |
| [human-in-the-loop](./human-in-the-loop/) | Approval Gate | 3-node pipeline with approval gate: Writer drafts, human reviews, Publisher finalizes |
| [map-reduce](./map-reduce/) | Map-Reduce | 4-node fan-out: Splitter decomposes a topic, Map fans out to parallel Researchers, Synthesizer merges results |
| [evolution](./evolution/) | Evolution (DGM) | Population-based Darwinian selection: parallel candidates, fitness scoring, temperature annealing, stagnation detection |
| [evolution-regex](./evolution-regex/) | Evolution (deterministic fitness) | Same evolution node, but a deterministic `fitnessFunction` replaces the LLM judge — evolves a regex scored by running it against fixed test cases (no judge variance, no scoring token cost) |
| [voting](./voting/) | Voting / Consensus | 3 voter agents evaluate a technical proposal independently; majority-vote aggregation with quorum enforcement |
| [verifier-fix-loop](./verifier-fix-loop/) | Verifier + Fix Loop | Deterministic verifier gates an LLM extraction; failures route to a fixer that uses verifier feedback |
| [learning-research-agent](./learning-research-agent/) | Reflection (Compound Learning) | Same graph runs twice on related goals — reflection extracts lessons after run 1, future runs retrieve them via `memory_query` |
| [eval-loop](./eval-loop/) | Conditional Cycle | 3-node cyclic graph: Writer drafts, Evaluator scores, loops back until quality gate (score >= 0.8) passes |
| [prompt-builder](./prompt-builder/) | Self-Annealing | 7-node workflow: Prompt Builder transforms vague goals into structured instructions, Critic scores quality, loop refines until threshold |

### Memory + context

| Example | Description |
|---------|-------------|
| [context-and-memory](./context-and-memory/) | Persistent memory hierarchy with context compression — seeds memory, runs workflow, ingests output, consolidates, detects conflicts |

### Infrastructure + integration

| Example | Description |
|---------|-------------|
| [streaming](./streaming/) | Real-time event streaming with token-by-token output via `stream()` async generator |
| [mcp-integration](./mcp-integration/) | Using built-in default MCP servers (Brave web search + fetch) via `registerDefaultMCPServers()` + `ToolSource[]` declarations |
| [ollama-local](./ollama-local/) | 2-node workflow against a local Ollama instance via `registerOllamaProvider()` — no API key needed |
| [postgres-persistence](./postgres-persistence/) | Durable state, event sourcing, and usage tracking via `@cycgraph/orchestrator-postgres` |
| [workflow-observer](./workflow-observer/) | "Triage observer" pattern — a separate workflow reads another workflow's event log + state and produces a structured triage report |

### Eval framework

| Example | Description |
|---------|-------------|
| [evals](./evals/) | Example eval suites showing how to write assertions against workflow outputs |

## Quick Start

```bash
cd packages/orchestrator
ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/research-and-write/research-and-write.ts
ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/supervisor-routing/supervisor-routing.ts
ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/human-in-the-loop/human-in-the-loop.ts
ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/map-reduce/map-reduce.ts
ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/evolution/evolution.ts
ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/voting/voting.ts
ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/verifier-fix-loop/verifier-fix-loop.ts
ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/learning-research-agent/learning-research-agent.ts
ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/eval-loop/eval-loop.ts
ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/prompt-builder/prompt-builder.ts
ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/streaming/streaming.ts
ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/context-and-memory/context-and-memory.ts
ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/workflow-observer/run.ts

# Ollama (no API key needed)
npx tsx examples/ollama-local/ollama-local.ts

# MCP (needs BRAVE_API_KEY for web search)
BRAVE_API_KEY=... ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/mcp-integration/mcp-integration.ts

# Postgres (needs docker-compose up -d + npm run db:migrate)
ANTHROPIC_API_KEY=sk-ant-... DATABASE_URL=postgresql://... npx tsx examples/postgres-persistence/postgres-persistence.ts
```

## Next Steps

- [README.md](../README.md) — Package overview, API reference, and custom provider setup
