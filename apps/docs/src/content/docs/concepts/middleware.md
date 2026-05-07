---
title: Middleware
description: Extension points for observing, transforming, or short-circuiting node execution.
---

Middleware provides hooks into the `GraphRunner` execution loop. Use middleware to add caching, logging, metrics, request transformation, or custom routing logic without modifying the runner or node executors.

## Registering middleware

Pass middleware instances to the `GraphRunner` via the `middleware` option. Hooks run in registration order:

```typescript
import { GraphRunner } from '@mcai/orchestrator';
import type { GraphRunnerMiddleware } from '@mcai/orchestrator';

const runner = new GraphRunner(graph, state, {
  middleware: [loggingMiddleware, cachingMiddleware],
});
```

## Hooks

All hooks are optional. Implement only the ones you need.

### `beforeNodeExecute(ctx)`

Called before a node runs. Return `{ shortCircuit: action }` to skip execution entirely and use the provided action instead. Useful for caching or circuit-breaking.

The example below uses a process-local `Map` so you can copy and run it; in production, swap in Redis or your existing cache backend. Caching keys should include both `node.id` and a hash of the relevant input — caching by node ID alone is unsafe whenever the inputs change between runs.

```typescript
import type { GraphRunnerMiddleware } from '@mcai/orchestrator';
import type { Action } from '@mcai/orchestrator';

const cache = new Map<string, Action>();

const cachingMiddleware: GraphRunnerMiddleware = {
  async beforeNodeExecute(ctx) {
    // Cache key combines node id with any inputs that influence the action.
    const key = `${ctx.node.id}:${JSON.stringify(ctx.state.memory.goal ?? '')}`;
    const cached = cache.get(key);
    if (cached) {
      return { shortCircuit: cached };
    }
  },

  async afterReduce(ctx, action) {
    const key = `${ctx.node.id}:${JSON.stringify(ctx.state.memory.goal ?? '')}`;
    cache.set(key, action);
  },
};
```

### `afterNodeExecute(ctx, action)`

Called after a node executes, before the action is applied by the reducer. Return a modified action to transform it, or `void` to keep the original.

```typescript
const enrichMiddleware: GraphRunnerMiddleware = {
  async afterNodeExecute(ctx, action) {
    return {
      ...action,
      metadata: {
        ...action.metadata,
        custom_field: 'enriched',
      },
    };
  },
};
```

### `afterReduce(ctx, action, newState)`

Called after the action has been reduced into state. This hook is **observational only** — the return value is ignored. Use it for logging, metrics, or external notifications.

```typescript
const metricsMiddleware: GraphRunnerMiddleware = {
  async afterReduce(ctx, action, newState) {
    metrics.recordNodeExecution(ctx.node.id, action.metadata.duration_ms);
  },
};
```

### `beforeAdvance(ctx, nextNodeId)`

Called before the runner advances to the next node. Return a node ID to override the routing decision, or `void` to keep the default.

```typescript
const routingMiddleware: GraphRunnerMiddleware = {
  async beforeAdvance(ctx, nextNodeId) {
    if (ctx.state.memory.urgent) {
      return 'fast-track-node';
    }
  },
};
```

## Context object

Every hook receives a `MiddlewareContext`:

| Field | Type | Description |
|-------|------|-------------|
| `node` | `GraphNode` | The node being executed. |
| `state` | `Readonly<WorkflowState>` | Current state snapshot (read-only). |
| `graph` | `Readonly<Graph>` | The graph definition (read-only). |
| `iteration` | `number` | Current iteration count. |

## Error handling

Errors thrown by middleware propagate to the runner's error handling — the same retry and failure policy that applies to node execution applies to middleware errors. Design middleware to be resilient and avoid throwing on non-critical failures.

## Next steps

- [Streaming](/concepts/streaming/) — observe execution via events instead of middleware
- [Nodes](/concepts/nodes/) — node types and failure policies
- [Error Handling](/concepts/error-handling/) — how errors propagate through the runner
