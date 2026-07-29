---
title: Streaming
description: Real-time event streaming for workflow monitoring, token output, and reactive UIs.
---

The [`GraphRunner`](/docs/concepts/graph-runner/) runs in two modes. `run()` executes to completion and returns the final state. `stream()` yields typed events as they occur, which enables real-time monitoring, token-by-token output, and reactive UIs without polling. Both modes emit the same events, so the difference is only how you consume them.

```typescript
import { GraphRunner, isTerminalEvent } from '@cycgraph/orchestrator';

const runner = new GraphRunner(graph, initialState, options);

for await (const event of runner.stream()) {
  switch (event.type) {
    case 'node:start':
      console.log(`Starting ${event.node_id}`);
      break;
    case 'agent:token_delta':
      process.stdout.write(event.token);
      break;
  }

  if (isTerminalEvent(event)) {
    console.log(`Final status: ${event.state.status}`);
  }
}
```

Events are a discriminated union on the `type` field, split into two categories. **Non-terminal** events are lightweight and carry no state copy. **Terminal** events carry the full `WorkflowState`. The full field reference is in [Interfaces](#interfaces); the sections below cover the events you reach for most often.

## Token streaming

The `agent:token_delta` event delivers individual tokens as they arrive from the LLM, which enables typewriter-style output in CLIs and real-time display in web UIs.

```typescript
for await (const event of runner.stream()) {
  if (event.type === 'agent:token_delta') {
    process.stdout.write(event.token);
  }
}
```

Token deltas are only emitted for agent nodes that use `streamText`, the default execution mode.

## Tool call streaming

The `tool:call_start` and `tool:call_finish` events fire in real time as tools execute within an agent node. They are powered by the AI SDK's `experimental_onToolCallStart` and `experimental_onToolCallFinish` callbacks, so they fire *during* the LLM interaction rather than post-hoc.

```typescript
for await (const event of runner.stream()) {
  if (event.type === 'tool:call_start') {
    console.log(`Calling ${event.tool_name}...`);
  }
  if (event.type === 'tool:call_finish') {
    const status = event.success ? 'done' : `failed: ${event.error}`;
    console.log(`  ${event.tool_name} ${status} (${event.duration_ms}ms)`);
  }
}
```

## Memory diffs

The `action:applied` event includes an optional `memory_diff` field showing exactly which memory keys an action added, changed, or removed. This lets real-time UIs display state changes without polling or comparing full snapshots.

```typescript
for await (const event of runner.stream()) {
  if (event.type === 'action:applied' && event.memory_diff) {
    const { added, changed, removed, values } = event.memory_diff;
    if (added.length > 0) console.log('  Added:', added);
    if (changed.length > 0) console.log('  Changed:', changed);
    if (removed.length > 0) console.log('  Removed:', removed);
  }
}
```

When no memory keys changed, such as a `goto_node` or `set_status` action, `memory_diff` is `undefined`, so no overhead is incurred. The shape is [`MemoryDiff`](#memorydiff).

## Forwarding events over SSE

`stream()` returns an async iterable, which maps directly to a Server-Sent Events handler. Below is a minimal Express endpoint that streams every workflow event to a connected client.

```typescript
import express from 'express';
import { GraphRunner, isTerminalEvent } from '@cycgraph/orchestrator';

const app = express();

app.get('/runs/:runId/stream', async (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const runner = new GraphRunner(graph, state, options);

  for await (const event of runner.stream()) {
    res.write(`event: ${event.type}\n`);
    res.write(`data: ${JSON.stringify(event)}\n\n`);
    if (isTerminalEvent(event)) break;
  }

  res.end();
});
```

WebSocket transports follow the same shape. Replace `res.write` with `socket.send` and serialize each event as JSON. Because terminal events carry the full `WorkflowState`, clients can compute the final result without polling.

## Event listeners (non-streaming)

When using `run()` instead of `stream()`, you can still observe events through the `EventEmitter`-style API. The runner extends `EventEmitter`, so `.on(type, handler)` receives the same event objects.

```typescript
const runner = new GraphRunner(graph, state, options);

runner.on('node:start', ({ node_id, node_type }) => {
  console.log(`Node started: ${node_id} (${node_type})`);
});

runner.on('budget:threshold_reached', ({ threshold_pct }) => {
  console.warn(`${threshold_pct}% of budget used`);
});

const finalState = await runner.run();
```

Use `stream()` when you need events as an async iterable, such as forwarding to a client over SSE or WebSocket. Use `run()` with `.on()` when you just need side-effect logging.

## API

### `stream`

Execute the graph, yielding a [`StreamEvent`](#streamevent) at each step. Pass an `AbortSignal` to cancel mid-run. Documented in full on the [Graph Runner](/docs/concepts/graph-runner/#stream) page.

```typescript
runner.stream(options?: { signal?: AbortSignal }): AsyncGenerator<StreamEvent>
```

### `isTerminalEvent`

Type guard that narrows a `StreamEvent` to a [`TerminalStreamEvent`](#terminal-events), the events that carry `state: WorkflowState`. Use it to access `event.state` with type safety.

```typescript
isTerminalEvent(event: StreamEvent): event is TerminalStreamEvent
```

```typescript
if (isTerminalEvent(event)) {
  console.log(event.state.status); // TypeScript knows event.state exists here
}
```

### `runner.on`

The `EventEmitter` listener API, available on any runner regardless of whether you call `run()` or `stream()`. `.on(type, handler)` fires the handler with the matching event object.

```typescript
runner.on(type: StreamEvent['type'], handler: (event) => void): void
```

## Interfaces

### StreamEvent

The discriminated union of every event the runner emits, keyed on `type`. Every event also carries a `timestamp` field (Unix ms). The members are catalogued below as [non-terminal](#non-terminal-events) and [terminal](#terminal-events) events.

### Non-terminal events

Lightweight events that carry no state copy.

| Event | Fields | Description |
|-------|--------|-------------|
| `workflow:start` | `workflow_id`, `run_id` | Workflow execution has begun. |
| `workflow:rollback` | `workflow_id`, `run_id` | Compensation stack is being unwound. |
| `workflow:paused` | `workflow_id`, `run_id`, `state` | Graceful shutdown paused the run (resumable). Carries state but is not terminal. |
| `node:start` | `node_id`, `node_type` | A node has started executing. |
| `node:complete` | `node_id`, `node_type`, `duration_ms` | A node has finished successfully. |
| `node:failed` | `node_id`, `node_type`, `error`, `attempt` | A node execution failed (may retry). |
| `node:retry` | `node_id`, `attempt`, `backoff_ms` | A failed node is being retried after a backoff delay. |
| `action:applied` | `action_id`, `action_type`, `node_id`, `memory_diff?` | A reducer applied an action to state. Includes a [`MemoryDiff`](#memorydiff) when keys changed. |
| `state:persisted` | `run_id`, `iteration` | State was persisted via `persistStateFn`. |
| `agent:token_delta` | `run_id`, `node_id`, `token` | A single token from an LLM response (real-time streaming). |
| `tool:call_start` | `run_id`, `node_id`, `tool_name`, `tool_call_id`, `args` | A tool has started executing. |
| `tool:call_finish` | `run_id`, `node_id`, `tool_name`, `tool_call_id`, `duration_ms`, `success`, `error?` | A tool has finished executing. |
| `budget:threshold_reached` | `run_id`, `workflow_id`, `threshold_pct`, `cost_usd`, `budget_usd` | Cost crossed a budget threshold (50%, 75%, 90%, 100%). |
| `model:resolved` | `run_id`, `node_id`, `agent_id`, `resolved_model`, `original_model`, `preference`, `reason`, `remaining_budget_usd?` | A model identifier was resolved, such as via budget-aware fallback. |
| `context:compressed` | `run_id`, `node_id`, `tokens_in`, `tokens_out`, `reduction_percent`, `duration_ms` | The context engine compressed a node's memory before prompt injection. |
| `memory:dropped` | `run_id`, `node_id?`, `key`, `reason`, `bytes?` | A memory write was rejected (`oversized`, `non_serializable`, or `reserved_key`). |

### Terminal events

Terminal events carry the full `WorkflowState` in their `state` field. Narrow to them with [`isTerminalEvent`](#isterminalevent).

| Event | Fields | Description |
|-------|--------|-------------|
| `workflow:complete` | `state`, `duration_ms` | Workflow finished successfully. |
| `workflow:failed` | `state`, `error` | Workflow failed with an unrecoverable error. |
| `workflow:timeout` | `state`, `elapsed_ms` | Workflow exceeded `max_execution_time_ms`. |
| `workflow:waiting` | `state`, `waiting_for` | Workflow paused for human input (HITL). |

### MemoryDiff

The set of memory changes an `action:applied` event carries in its `memory_diff` field. `undefined` when the action changed no memory keys.

| Field | Type | Description |
|-------|------|-------------|
| `added` | `string[]` | Keys that were added (not present before). |
| `changed` | `string[]` | Keys whose values changed. |
| `removed` | `string[]` | Keys that were removed. |
| `values` | `Record<string, unknown>` | New values for added and changed keys. |

## Next steps

- [Graph Runner](/docs/concepts/graph-runner/): the engine that produces the event stream
- [Cost & Budget Tracking](/docs/concepts/cost-tracking/): budget threshold events
- [Nodes](/docs/concepts/nodes/): what each node type emits during execution
- [Error Handling](/docs/concepts/error-handling/): failure and timeout events
