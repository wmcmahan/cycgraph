---
title: Introduction
description: What cycgraph is, why it exists, and how it differs from other orchestration frameworks.
---

**cycgraph** is a production-grade agentic orchestration framework built on a prescriptive **Cyclic State Graph** architecture. It gives developers explicit control over how agents execute, loop, transition state, and recover from failures in complex AI workflows.

Unlike traditional directed acyclic graph (DAG) pipelines, cycgraph natively supports **cyclic workflows**—allowing nodes to loop back based on validation results, pause for human-in-the-loop review, coordinate multi-agent teams, and self-correct dynamically.

## Why cycgraph?

Most agent frameworks treat multi-agent execution as linear chains or unconstrained LLM loops. cycgraph bridges the gap by enforcing a structured state model with predictable boundaries:

- **State Slicing & Security:** Nodes only read from (`read_keys`) and write to (`write_keys`) explicit slices of the shared workflow state.
- **Durable Execution:** State and event logs are persisted step-by-step, guaranteeing crash recovery and time-travel debugging.
- **Production Guardrails:** Enforce cost, token, iteration, and execution time limits at the engine level.

## What you get

- **Cyclic graph engine.** Loops, retries, conditional routing, nested subgraphs, parallel fan-out.
- **Durable execution.** Every action is persisted, so runs survive crashes via event-sourced replay.
- **Zero-trust security.** Per-node `reads` / `writes` grants, taint tracking on all external data, an allowlist for MCP servers and remote agents.
- **Budget guardrails.** Token, cost, iteration, and wall-clock limits, all enforced at the engine.
- **Production observability.** OpenTelemetry tracing, structured events, real-time streaming via async iterables.
- **Pluggable persistence.** In-memory by default, with a Postgres adapter for production durability.

## Built-in patterns

Each is a first-class node type with a dedicated authoring helper, not a recipe you assemble yourself.

| Pattern | What it does |
|---------|--------------|
| [Supervisor](/docs/patterns/supervisor/) | An LLM routes work to a team of nodes until the goal is met. |
| [Swarm](/docs/patterns/swarm/) | Peer agents hand off to each other without a central router. |
| [Evolution](/docs/patterns/evolution/) | Population-based selection: generate, score, breed, repeat. |
| [Reflection](/docs/patterns/reflection/) | Distills a run's output into facts a later run retrieves. |
| [Self-Annealing](/docs/patterns/self-annealing/) | Refines against a critic's score until it clears a threshold. |
| [Voting / Consensus](/docs/patterns/voting/) | Several agents answer independently; a strategy aggregates. |
| [Verifier](/docs/patterns/verifier/) | Gates output on an LLM judge, an expression, or a JSONPath assertion. |
| [Map-Reduce](/docs/patterns/map-reduce/) | Fans out over a collection in parallel, then fans back in. |
| [Human-in-the-Loop](/docs/patterns/human-in-the-loop/) | Pauses the run for a human decision and resumes where it stopped. |
| [Subgraph](/docs/patterns/subgraph/) | Embeds a whole graph as one node, with isolated state. |
| [A2A](/docs/patterns/a2a/) | Delegates a step to a remote agent over the Agent2Agent protocol. |

Alongside these, `router`, `synthesizer`, and `tool` nodes are the primitives for composing your own.

## Core Concepts

Every workflow in cycgraph is constructed from a few fundamental building blocks:

- **[Graph](/docs/concepts/graphs/)**: The declarative workflow definition composed of nodes connected by static or conditional edges, supporting cyclic loops and subgraphs.
- **[Node](/docs/concepts/nodes/)**: The discrete unit of work within a graph—such as executing an agent, routing conditionally, waiting for human approval, or running parallel maps.
- **[Agent](/docs/concepts/agents/)**: The LLM wrapper configured with specific system prompts, models, and injected tool capabilities that performs intelligent tasks.
- **[Workflow State](/docs/concepts/workflow-state/)**: The centralized, auditable blackboard state object from which nodes read inputs and write outputs under strict scoping permissions.
- **[Graph Runner](/docs/concepts/graph-runner/)**: The execution engine that steps through nodes, evaluates edge conditions, merges state updates, and handles persistence and event streaming.
- **[Tools & MCP](/docs/concepts/tools-and-mcp/)**: The integration layer connecting agents and nodes securely to Model Context Protocol (MCP) servers and external APIs.

## Next steps

- [Your First Workflow](/docs/guides/first-workflow/): Install `@cycgraph/orchestrator` and run a workflow in under 5 minutes.
- [Concepts Overview](/docs/concepts/overview/): Deep dive into the architecture and execution model.
- [Workflow Patterns](/docs/patterns/supervisor/): Explore the built-in patterns above in depth.
