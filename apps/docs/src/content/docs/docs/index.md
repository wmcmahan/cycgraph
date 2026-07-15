---
title: cycgraph Documentation
description: Production-grade agentic orchestration on a Cyclic State Graph. Build complex multi-agent workflows that loop, branch, and recover.
---

cycgraph is a production-grade **Agentic Orchestration System** built on a **Cyclic State Graph**. It powers complex, multi-step AI workflows — Supervisors, Swarms, Evolution (DGM), Self-Annealing loops, Reflection, and Human-in-the-Loop — where AI agents are nodes that read from and write to a shared state "blackboard."

## Why a Cyclic State Graph

Most agent frameworks model workflows as DAGs — agent A calls B calls C. That works for simple pipelines and breaks for everything else: looping back on validation feedback, supervisors that route dynamically, populations that evolve in parallel, workflows that pause for human review and resume hours later.

cycgraph solves this with a **Cyclic State Graph**: nodes that can loop, revisit prior nodes, and make routing decisions by reading from a shared state object. Every state transition is auditable. Workflows survive crashes. Agents can't see what they shouldn't.

## What you get

- **Cyclic graph engine** — loops, retries, conditional routing, nested subgraphs, parallel fan-out.
- **Built-in patterns** — [Supervisor](/docs/patterns/supervisor/), [Swarm](/docs/patterns/swarm/), [Evolution](/docs/patterns/evolution/), [Reflection](/docs/patterns/reflection/), [Self-Annealing](/docs/patterns/self-annealing/), [Voting / Consensus](/docs/patterns/voting/), [Verifier](/docs/patterns/verifier/), [Map-Reduce](/docs/patterns/map-reduce/), [Human-in-the-Loop](/docs/patterns/human-in-the-loop/) — each a first-class node type, with router, synthesizer, and subgraph primitives to compose your own.
- **Durable execution** — every action persisted; runs survive crashes via event-sourced replay.
- **Zero-trust security** — per-node `read_keys` / `write_keys`, taint tracking on all external data, MCP server allowlist.
- **Budget guardrails** — token, cost (USD), iteration, and wall-clock limits, all enforced at the engine.
- **Production observability** — OpenTelemetry tracing, structured events, real-time streaming via async iterables.
- **Pluggable persistence** — in-memory by default; Postgres adapter for production durability.

## Get started

```bash
npm install @cycgraph/orchestrator
```

Pick the path that fits where you are:

- [Quick Start](/docs/getting-started/quick-start/) — install, set an API key, run a workflow in five minutes.
- [Core Concepts](/docs/concepts/overview/) — graphs, nodes, agents, state. The four primitives.
- [Workflow Patterns](/docs/patterns/supervisor/) — runnable examples of each pattern.
- [Architect](/docs/guides/architect/) — generate workflow graphs from natural language.

If something breaks on the first run, [Troubleshooting](/docs/getting-started/troubleshooting/) covers the common errors and their fixes.
