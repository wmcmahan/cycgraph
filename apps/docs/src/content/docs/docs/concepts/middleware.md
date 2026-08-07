---
title: Middleware
description: Extension points for observing, transforming, or short-circuiting node execution.
---

Middleware provides hooks into the [runner](/docs/concepts/graph-runner/) execution loop. Use it to add caching, logging, metrics, request transformation, or custom routing without modifying the runner or the node executors. A middleware is a plain object with one or more optional hook methods, so there is nothing to instantiate. You implement the hooks you need and pass the object to the runner.

```typescript
import { GraphRunner } from '@cycgraph/orchestrator';

const runner = new GraphRunner(graph, state, {
  middleware: [loggingMiddleware, cachingMiddleware],
});
```

## How middleware runs

The runner invokes hooks at four points in each node's lifecycle.

- **beforeNodeExecute**: runs first, before the node executes.
- **afterNodeExecute**: runs once the node produces an action, before the reducer applies it.
- **afterReduce**: runs after the action has merged into state.
- **beforeAdvance**: runs last, before the runner picks the next node.

Hooks run synchronously in registration order. If you pass `[a, b]`, then `a`'s hook completes before `b`'s hook for the same point in the lifecycle. Each hook is `async`, so the runner awaits it before moving on.

**Refs:**
- [GraphRunnerMiddleware](#graphrunnermiddleware): the four hooks and their signatures.
- [MiddlewareContext](#middlewarecontext): the read-only context every hook receives.

## Registering middleware

Pass an array of middleware to the runner through the `middleware` option on [GraphRunnerOptions](/docs/concepts/graph-runner/#graphrunneroptions). The array order is the run order.

```typescript
const runner = new GraphRunner(graph, state, {
  middleware: [loggingMiddleware, cachingMiddleware],
});
```

## Hooks

All hooks are optional. Implement only the ones you need. Every hook receives a [MiddlewareContext](#middlewarecontext) as its first argument.

### beforeNodeExecute

Called before a node runs. Return `{ shortCircuit: action }` to skip execution entirely and use the provided action instead. This is the hook for caching or circuit-breaking.

The example below uses a process-local `Map` so you can copy and run it. In production, swap in Redis or your existing cache backend. Cache keys should include both `node.id` and a hash of the relevant input. Caching by node ID alone is unsafe whenever the inputs change between runs.

```typescript
import type { GraphRunnerMiddleware } from '@cycgraph/orchestrator';
import type { Action } from '@cycgraph/orchestrator';

const cache = new Map<string, Action>();

const cachingMiddleware: GraphRunnerMiddleware = {
  async beforeNodeExecute(ctx) {
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

### afterNodeExecute

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

### afterReduce

Called after the action has been reduced into state. This hook is observational only, so its return value is ignored. Use it for logging, metrics, or external notifications.

```typescript
const metricsMiddleware: GraphRunnerMiddleware = {
  async afterReduce(ctx, action, newState) {
    metrics.recordNodeExecution(ctx.node.id, action.metadata.duration_ms);
  },
};
```

### beforeAdvance

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

**Refs:**
- [`GraphRunnerMiddleware`](#graphrunnermiddleware): the full hook signatures.
- [`BeforeNodeResult`](#beforenoderesult): the shape `beforeNodeExecute` returns to short-circuit.
- [`MiddlewareContext`](#middlewarecontext): the `ctx` each hook receives.

## Error handling

Errors thrown by middleware propagate to the runner's error handling. The same retry and failure policy that applies to node execution applies to middleware errors. Design middleware to be resilient, and avoid throwing on non-critical failures.

**Refs:**
- [Error Handling](/docs/concepts/error-handling/): how errors propagate through the runner.

## Interfaces

### GraphRunnerMiddleware

The middleware object you pass to the runner. All hooks are optional. Instances are called in registration order, and errors thrown by any hook propagate to the runner's error handling.

| Hook | Signature | Description |
|------|-----------|-------------|
| `beforeNodeExecute` | `(ctx: MiddlewareContext) => Promise<BeforeNodeResult \| void>` | Runs before a node executes. Return a `shortCircuit` action to skip execution. |
| `afterNodeExecute` | `(ctx: MiddlewareContext, action: Action) => Promise<Action \| void>` | Runs after a node executes, before the action is reduced. Return a transformed action or `void` to keep the original. |
| `afterReduce` | `(ctx: MiddlewareContext, action: Action, newState: Readonly<WorkflowState>) => Promise<void>` | Runs after the action reduces into state. Observational only: the return value is ignored. |
| `beforeAdvance` | `(ctx: MiddlewareContext, nextNodeId: string) => Promise<string \| void>` | Runs before advancing to the next node. Return a node ID to override routing, or `void` to keep the default. |

### MiddlewareContext

The read-only context passed as the first argument to every hook.

| Field | Type | Description |
|-------|------|-------------|
| `node` | `GraphNode` | The node being executed. |
| `state` | `Readonly<WorkflowState>` | Current workflow state snapshot (read-only). |
| `graph` | `Readonly<Graph>` | The graph definition (read-only). |
| `iteration` | `number` | Current iteration count. |

### BeforeNodeResult

The result a `beforeNodeExecute` hook may return.

| Field | Type | Description |
|-------|------|-------------|
| `shortCircuit` | `Action` | If set, skip node execution and reduce this action instead. |

## Next steps

- [Graph Runner](/docs/concepts/graph-runner/): the execution loop middleware hooks into
- [Streaming](/docs/concepts/streaming/): observe execution via events instead of middleware
- [Nodes](/docs/concepts/nodes/): node types and failure policies
- [Error Handling](/docs/concepts/error-handling/): how errors propagate through the runner
