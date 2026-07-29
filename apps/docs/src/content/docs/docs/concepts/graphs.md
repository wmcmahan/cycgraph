---
title: Graphs
description: How to define workflow graphs with edges and conditional routing.
---

A **Graph** defines the deterministic structure of a workflow: which nodes exist, how they connect, and the conditions under which edges are traversed. A graph can be cyclic or acyclic, depending on what the workflow needs.

```typescript
import { createGraph } from '@cycgraph/orchestrator';

const graph = createGraph({
  name: "Research Pipeline",
  description: "Searches the web and writes a summary",
  startNode: "researcher",
  endNodes: ["writer"],
  nodes: [/* ... */],
  edges: [/* ... */]
});
```

Author graphs with [`createGraph`](#creategraph), which takes camelCase input and fills defaults. The [`GraphRunner`](/docs/concepts/graph-runner/) executes the result: it runs the `startNode`, then follows edges from node to node until it reaches one of the `endNodes`.

## Edges

An **Edge** is a directed connection between a source node and a target node.

When a node completes, the orchestrator evaluates all outgoing edges from that node. The edge's condition determines whether it is traversed.

If the node is **not** a declared end node and **no** outgoing edge's condition matches, that's a dead-end. The runner fails the run with `NoMatchingEdgeError` rather than silently treating it as completion. Make sure every non-terminal node has at least one edge whose condition can match (an `always` edge is the simplest fallback), or list genuinely-terminal nodes in `endNodes`. Set `allowImplicitCompletion: true` on [`GraphRunnerOptions`](/docs/concepts/graph-runner/#graphrunneroptions) for the legacy silent-completion behavior.

### Edge conditions

An edge's `condition` selects one of three routing strategies.

| Type | Description | Required fields |
|------|-------------|-----------------|
| `always` | Unconditional routing. The edge is always traversed. | — |
| `conditional` | Dynamic routing. Evaluates a filtrex expression against the workflow's `memory` state. | `condition: string` |
| `map` | Specialized edge used exclusively by map-reduce fan-out nodes. | — |

**Refs:**
- [GraphEdge](#graphedge): The edge shape and its fields.
- [EdgeCondition](#edgecondition): The routing-condition shape.

## Validation

A graph is validated before it runs. [`validateGraph`](#validategraph) checks structure: that `startNode` and every `endNode` exist, that edges reference real nodes, that end nodes are reachable, and that `conditional` edge expressions compile. It returns errors (which block execution) and warnings (suspicious but valid, such as a node with wildcard `read_keys`). The `GraphRunner` runs this at load time, and the architect runs it before persisting a generated graph.

**Refs:**
- [`validateGraph`](#validategraph): Structural validation pass.
- [ValidationResult](#validationresult): The errors-and-warnings result shape.

## API

### `createGraph`

Build a `Graph` from camelCase authoring input. Auto-generates `id` when omitted, applies defaults (edge `condition` defaults to `always`, `strictTaint` to `false`), and validates structure through `GraphSchema`. To build from the snake_case wire format instead (a graph loaded from the database or produced by the architect), use `GraphSchema.parse` directly.

```typescript
createGraph(input: GraphConfig): Graph
```

##### Options

The input is a [`GraphConfig`](#graph): the [`Graph`](#graph) fields in camelCase, with `id` and `strictTaint` optional.

### `validateGraph`

Run the structural validation pass on a built graph. `O(N + E)` over nodes and edges. A graph is safe to execute only when the returned `errors` array is empty.

```typescript
validateGraph(graph: Graph): ValidationResult
```

## Interfaces

### Graph

A workflow definition. Authored in camelCase via [`createGraph`](#creategraph); the stored and runtime form is snake_case.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `id` | `string` (UUID) | auto-generated | Unique identifier for the graph definition. |
| `name` | `string` | *required* | Human-readable name. |
| `description` | `string` | *required* | What this graph does. |
| `nodes` | [`GraphNode[]`](/docs/concepts/nodes/) | *required* | The nodes that define the work. Capped at 10,000. |
| `edges` | [`GraphEdge[]`](#graphedge) | *required* | Directed edges defining the flow of execution. Capped at 10,000. |
| `startNode` | `string` | *required* | ID of the first node to execute. |
| `endNodes` | `string[]` | *required* | Terminal node IDs. Execution stops when one is reached. |
| `strictTaint` | `boolean` | `false` | When `true`, reject routing decisions that reference tainted memory keys instead of only warning. See [Taint Tracking](/docs/concepts/taint-tracking/). |

### GraphEdge

A directed connection between two nodes.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `id` | `string` (UUID) | auto-generated | Unique edge identifier, used in validation messages and debug logs. |
| `source` | `string` | *required* | Source node ID. |
| `target` | `string` | *required* | Target node ID. |
| `condition` | [`EdgeCondition`](#edgecondition) | `{ type: 'always' }` | Routing logic. |
| `metadata` | `Record<string, unknown>` | — | Arbitrary metadata for tooling and debugging. |

### EdgeCondition

The routing condition on an edge. See [Edge conditions](#edge-conditions) for what each `type` does.

| Field | Type | Description |
|-------|------|-------------|
| `type` | `'always'` \| `'conditional'` \| `'map'` | Routing strategy. |
| `condition` | `string?` | Filtrex expression, such as `"memory.decision == 'A'"`. Required for `conditional`. |
| `value` | `unknown?` | Expected value for simple equality checks. |

### ValidationResult

The result of a [`validateGraph`](#validategraph) pass.

| Field | Type | Description |
|-------|------|-------------|
| `valid` | `boolean` | `true` when `errors` is empty and the graph is safe to execute. |
| `errors` | `string[]` | Fatal issues that prevent execution. |
| `warnings` | `string[]` | Suspicious configurations that may indicate mistakes, such as unreachable nodes. |

## Next steps

- [Nodes](/docs/concepts/nodes/): node types, configuration, and state slicing
- [Graph Runner](/docs/concepts/graph-runner/): the engine that executes a graph
- [Workflow State](/docs/concepts/workflow-state/): the shared state edges route on
- [Agents](/docs/concepts/agents/): how agent nodes work
