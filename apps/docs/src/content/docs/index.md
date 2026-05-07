---
title: MC-AI
description: Production-grade agentic orchestration on a Cyclic State Graph. Build complex multi-agent workflows that loop, branch, and recover.
template: splash
hero:
  tagline: Build complex multi-agent workflows that loop, branch, and recover. Cyclic graphs, durable state, zero-trust security.
  actions:
    - text: Quick Start
      link: /getting-started/quick-start/
      icon: right-arrow
      variant: primary
    - text: Core Concepts
      link: /concepts/overview/
      icon: right-arrow
      variant: secondary
---

## Why MC-AI

Most agent frameworks model workflows as DAGs — agent A calls B calls C. That works for simple pipelines and breaks for everything else: looping back on validation feedback, supervisors that route dynamically, populations that evolve in parallel, workflows that pause for human review and resume hours later.

MC-AI solves this with a **Cyclic State Graph**: nodes that can loop, revisit prior nodes, and make routing decisions by reading from a shared state object. Every state transition is auditable. Workflows survive crashes. Agents can't see what they shouldn't.

## What you get

- **Cyclic graph engine** — loops, retries, conditional routing, nested subgraphs, parallel fan-out.
- **Six built-in patterns** — [Supervisor](/patterns/supervisor/), [Swarm](/patterns/swarm/), [Evolution](/patterns/evolution/), [Self-Annealing](/patterns/self-annealing/), [Map-Reduce](/patterns/map-reduce/), [Human-in-the-Loop](/patterns/human-in-the-loop/).
- **Durable execution** — every action persisted; runs survive crashes via event-sourced replay.
- **Zero-trust security** — per-node `read_keys` / `write_keys`, taint tracking on all external data, MCP server allowlist.
- **Budget guardrails** — token, cost (USD), iteration, and wall-clock limits, all enforced at the engine.
- **Production observability** — OpenTelemetry tracing, structured events, real-time streaming via async iterables.
- **Pluggable persistence** — in-memory by default; Postgres adapter for production durability.

## Get started

```bash
npm install @mcai/orchestrator
```

Pick the path that fits where you are:

- [Quick Start](/getting-started/quick-start/) — install, set an API key, run a workflow in five minutes.
- [Core Concepts](/concepts/overview/) — graphs, nodes, agents, state. The four primitives.
- [Workflow Patterns](/patterns/supervisor/) — runnable examples of each pattern.
- [Architect](/guides/architect/) — generate workflow graphs from natural language.

If something breaks on the first run, [Troubleshooting](/getting-started/troubleshooting/) covers the common errors and their fixes.
