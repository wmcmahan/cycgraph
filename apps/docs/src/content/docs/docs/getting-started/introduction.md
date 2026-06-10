---
title: Introduction
description: What cycgraph is, why it exists, and how it differs from other orchestration frameworks.
---

cycgraph is an **agentic orchestration engine** built on a Cyclic State Graph architecture. It enables building complex, fault-tolerant, multi-step AI workflows.

## Why use cycgraph?

Most AI orchestration frameworks model workflows as linear chains or strict DAGs (Directed Acyclic Graphs) — agent A calls agent B, which calls agent C. This works well for simple pipelines, but falls apart when you need:

- An agent to **loop back** and try again based on validation feedback.
- A supervisor to **dynamically route** work based on real-time findings.
- Multiple candidates to **evolve in parallel** across generations to find the absolute best solution.
- A workflow to **pause for human review** and resume safely hours later without context loss.

cycgraph solves this by using a **Cyclic State Graph**. Nodes in the graph can loop, revisit previous nodes, and make runtime routing decisions by reading from a single shared state object.

## Core mental model

Everything in cycgraph revolves around four core concepts:

| Concept | What it is |
|---------|-----------| 
| **Graph** | Your workflow definition — a set of nodes connected by edges. |
| **Node** | A unit of work: an Agent, an MCP Tool, a Supervisor, or a Subgraph. |
| **State** | A shared state object. All nodes read from and write to this state. |
| **Reducer** | A pure function that takes the current state and an action, and returns the new state. |

Agents never talk directly to each other. They read from the shared state, do their work, and emit actions. Reducers apply those actions to produce a new state. This guarantees that **every state transition is auditable** and enables features like time-travel debugging and workflow rollbacks.

## Architecture overview

Here is how the underlying graph runner executes your workflows:

```mermaid
flowchart TB
    Start(["run() / stream()"]) --> EvalStart["Evaluate Start Node"]
    EvalStart --> ExecNode{"Execute Node"}
    
    ExecNode -->|Agent Node| LLM["LLM + Tools"]
    ExecNode -->|Supervisor| Route["Route Decision"]
    ExecNode -->|Map Node| Parallel["Parallel Fan-Out"]
    ExecNode -->|Subgraph| Nested["Nested Graph"]
    
    LLM --> Reduce["Apply Reducer → Update State"]
    Route --> Reduce
    Parallel --> Reduce
    Nested --> Reduce
    
    Reduce --> Persist["Persist Event/Checkpoint"]
    Persist --> EvalEdges["Evaluate Edge Conditions"]
    
    EvalEdges --> Loop{"Is End Node?"}
    
    Loop -->|"No"| ExecNode
    Loop -->|"Yes"| Done(["__done__"])
```

Because the graph runner is a lightweight TypeScript library, there's no heavy control plane to spin up. You can embed it directly in your Fastify/Express server, run it in a serverless function, or scale horizontally using the built-in [`WorkflowWorker`](/docs/concepts/distributed-execution/) — which distributes workflows across multiple processes with automatic crash recovery.

## What cycgraph is not

- **Not a chatbot UI builder** — cycgraph is a backend workflow engine.
- **Not a low-code tool** — Workflows are defined in TypeScript with full type safety, not a drag-and-drop builder.

## Next steps

- [Quick Start](/docs/getting-started/quick-start/) — install the library and run a workflow in under 5 minutes.
- [Core Concepts](/docs/concepts/overview/) — dive deeper into the graph model.
