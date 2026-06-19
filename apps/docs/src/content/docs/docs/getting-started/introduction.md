---
title: CYCGRAPH
description: What cycgraph is, why it exists, and how it differs from other orchestration frameworks.
---

**CYCGRAPH** is an agentic orchestration framework built on a **Cyclic State Graph** architecture with the goal of allowing for more prescriptive control over how your agents step through workflows.

## Core Concepts

Agents maintain their own context; reading and writing it to the shared state. This guarantees that every state transition is predictable, auditable, and enables features like time-travel debugging and workflow rollbacks.

Everything in cycgraph revolves around three core concepts:

- **Graph** - The workflow definition — from simple directed acyclic graphs to complex cyclic graphs with conditional edges representing an agents workflow.
- **Node** - The runnable unit of work - containing an Agent, MCP, tool calls, or even another subgrah.
- **State** - The shared state from which all nodes read and write.

## What CYCGRAPH is not

- **Not a chatbot UI builder** — **CYCGRAPH** is a orchestration framework aimed to help simplify the development of complex agentic workflows.
- **Not a low-code tool** — Workflows are defined in TypeScript with full type safety, not a drag-and-drop builder.

## Next steps

- [Quick Start](/docs/getting-started/quick-start/) — install the library and run a workflow in under 5 minutes.
- [Core Concepts](/docs/concepts/overview/) — dive deeper into the graph model.
