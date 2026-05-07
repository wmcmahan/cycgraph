---
title: Graphs
description: How to define workflow graphs with edges and conditional routing.
---

A **Graph** defines the deterministic structure of a workflow — which nodes exist, how they connect, and the conditions under which edges are traversed. They can be cyclic or acyclic depending on the need.

### Creating a graph

Use the `createGraph` helper to build a validated `Graph` object. The `id` is auto-generated if omitted:

```typescript
import { createGraph } from '@mcai/orchestrator';

const graph = createGraph({
  name: "Research Pipeline",
  description: "Searches the web and writes a summary",
  start_node: "researcher",
  end_nodes: ["writer"],
  nodes: [
    // ... Node definitions ...
  ],
  edges: [
    // ... Edge definitions ...
  ]
});
```

## Graph configuration

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `id` | `string` (UUID) | auto-generated | Unique identifier for the graph definition. |
| `name` | `string` | *required* | Human-readable name. |
| `description` | `string` | *required* | Description of what this graph does. |
| `nodes` | `GraphNode[]` | *required* | List of nodes that define the work to be done. |
| `edges` | `GraphEdge[]` | *required* | Directed edges defining the flow of execution. |
| `start_node` | `string` | *required* | The ID of the first node to execute. |
| `end_nodes` | `string[]` | *required* | Terminal node IDs. Execution stops here. |

## Edges

An **Edge** is a directed connection between a source node and a target node.

When a node completes, the orchestrator evaluates all outgoing edges from that node. The condition determines whether the edge is traversed.

### Edge configuration

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `id` | `string` (UUID) | auto-generated | Unique identifier for the edge (used in validation messages and debug logs). |
| `source` | `string` | *required* | Source node ID. |
| `target` | `string` | *required* | Target node ID. |
| `condition` | `EdgeCondition` | `{ type: 'always' }` | Routing logic. |
| `metadata` | `object` | `{}` | Arbitrary metadata for tooling/debugging. |

### Edge conditions

| Type | Description | Required fields |
|------|-------------|-----------------|
| `always` | Unconditional routing. The edge is always traversed. | — |
| `conditional` | Dynamic routing. Evaluates an expression against the workflow's `memory` state. | `condition: string` |
| `map` | Specialized edge used exclusively by map-reduce fan-out nodes. | — |

**Conditional example:**

Loops back to the writer if score is low.

```typescript
{
  source: "evaluator",
  target: "writer",
  condition: {
    type: "conditional",
    condition: "memory.draft_score < 0.8"
  }
}
```

## Next steps

- [Nodes](/concepts/nodes/) — node types, configuration, and state slicing
- [Workflow State](/concepts/workflow-state/) — the shared state object
- [Agents](/concepts/agents/) — how agent nodes work
