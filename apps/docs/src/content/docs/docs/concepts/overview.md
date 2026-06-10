---
title: How cycgraph Works
description: A high-level overview of the Cyclic State Graph architecture and its core concepts.
---

cycgraph is a **workflow engine** built around four primary concepts: Graphs, Nodes, Agents, and State.

## The core concepts

### 1. Graphs

A Graph is the declarative definition of a workflow — a set of nodes connected by conditional routing edges. Unlike linear pipelines, cycgraph graphs can be **cyclic**: nodes can loop back to previous nodes. This enables powerful autonomous patterns like self-correction, iterative refinement, and dynamic routing.

Graphs are defined in TypeScript (or generated organically by the [Architect](/docs/guides/architect/)) and can be versioned, composed into nested subgraphs, and updated without redeploying your core infrastructure.

### 2. Nodes

A Node is a discrete unit of work within a Graph. When a workflow is executed, the orchestrator traverses the graph and executes the logic defined inside each active node. 

There are 12 core node types in cycgraph, ranging from simple conditionals and fan-out maps (`router`, `map`), to human-in-the-loop pauses (`approval`), to complex population-based breeding algorithms (`evolution`), to compound-learning primitives (`reflection`).

*(See the full [Nodes reference](/docs/concepts/nodes/) for all available types.)*

### 3. Agents

While a Node defines *where* work happens in the workflow, an Agent usually defines *how* the intelligent work is done. Agents wrap LLMs with specific system prompts, configured models, and injected tool capabilities. 

Agents are decoupled from Nodes. You register your Agents in an `AgentRegistry`, and then multiple different `agent` or `supervisor` nodes can reference the exact same Agent, optionally overriding its available tools based on the Graph's current context.

### 4. Workflow State

Instead of passing output directly between nodes in a fragile chain, all nodes in cycgraph read from and write to a **shared state object** — the `WorkflowState`.

```typescript
{
  workflow_id: "research-pipeline",
  run_id: "uuid-1234",
  goal: "Write a blog post about AI Agents",
  memory: {
    topic: "Future of Autonomous Agents",
    draft: "...",
  },
  status: "running",
}
```

Nodes only read the keys they are explicitly permitted to access (`read_keys`) and write only to the keys they are allowed to modify (`write_keys`). This enforces **state slicing** — ensuring agents only see the context they genuinely need, reducing hallucination risks and token costs.

## Execution Flow

When you execute a workflow, the `GraphRunner` orchestrates the process safely:

1. It loads the Graph definition and the initial State.
2. It executes the `start_node`.
3. The node performs its work (e.g., an Agent calls an LLM, uses Tools via **MCP**, and yields a result).
4. The result is safely merged back into the Workflow State.
5. The runner evaluates the node's outgoing edges against the new complete State.
6. Execution routes to the next target node(s).
7. This loops until an `end_node` is reached or an error halts the run.

## Persistence and resumability

Because State is cleanly separated from the execution logic, it can be persisted (in-memory by default, or durably to Postgres via `@cycgraph/orchestrator-postgres`) after every single node execution. This enables:

- **Time-travel debugging** — inspect state at any point in the workflow's history.
- **Resumability** — restart from the exact last checkpoint if an API crashes.
- **Human-in-the-Loop** — pause mid-workflow, wait days for human approval, and resume identically.

## Distributed execution

For production deployments with concurrent workflows, the `WorkflowWorker` distributes execution across multiple processes. Each workflow runs on one worker for its entire lifetime — the `GraphRunner` is used as-is inside each worker.

Workers poll a `WorkflowQueue` for jobs, execute them, and report results. Crashed workers are detected via visibility timeouts; their jobs are reclaimed and recovered on another worker by reconciling event-log replay against the latest state snapshot. **Run fencing** (a per-claim epoch, with the `DrizzleWorkflowQueue`) ensures a reclaimed-but-still-alive worker can't clobber the new owner.

See [Distributed Execution](/docs/concepts/distributed-execution/) for details.

## Next steps

Explore the core concepts in detail:

- [Graphs](/docs/concepts/graphs/) — structure and edge routing
- [Nodes](/docs/concepts/nodes/) — the active components of a workflow
- [Agents](/docs/concepts/agents/) — injecting intelligence
- [Workflow State](/docs/concepts/workflow-state/) — how memory is managed
- [Tools & MCP](/docs/concepts/tools-and-mcp/) — how agents safely interact with the world
- [Distributed Execution](/docs/concepts/distributed-execution/) — scaling across multiple processes
- [Error Handling](/docs/concepts/error-handling/) — building resilient graphs
