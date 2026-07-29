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
- [Workflow Patterns](/docs/patterns/supervisor/): Explore pre-built patterns like Supervisor, Swarm, Evolution, and Human-in-the-Loop.
