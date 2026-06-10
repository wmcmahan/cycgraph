---
title: Streaming
description: Real-time event streaming for workflow monitoring, token output, and reactive UIs.
---

The `GraphRunner` supports two execution modes: `run()` (returns the final state) and `stream()` (yields typed events as they occur). Streaming enables real-time monitoring, token-by-token output, and reactive UIs without polling.

## Basic usage

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

## Event types

Events are a discriminated union on the `type` field. They split into two categories: **non-terminal** (lightweight, no state copy) and **terminal** (carry the full `WorkflowState`).

### Non-terminal events

| Event | Fields | Description |
|-------|--------|-------------|
| `workflow:start` | `workflow_id`, `run_id` | Workflow execution has begun. |
| `workflow:rollback` | `workflow_id`, `run_id` | Compensation stack is being unwound. |
| `node:start` | `node_id`, `type` | A node has started executing. |
| `node:complete` | `node_id`, `type`, `duration_ms` | A node has finished successfully. |
| `node:failed` | `node_id`, `type`, `error`, `attempt` | A node execution failed (may retry). |
| `node:retry` | `node_id`, `attempt`, `backoff_ms` | A failed node is being retried after a backoff delay. |
| `action:applied` | `action_id`, `action_type`, `node_id`, `memory_diff?` | A reducer has applied an action to state. Includes memory diff when keys changed. |
| `state:persisted` | `run_id`, `iteration` | State has been persisted (via `persistStateFn`). |
| `agent:token_delta` | `run_id`, `node_id`, `token` | A single token from an LLM response (real-time streaming). |
| `tool:call_start` | `run_id`, `node_id`, `tool_name`, `tool_call_id`, `args` | A tool has started executing. |
| `tool:call_finish` | `run_id`, `node_id`, `tool_name`, `tool_call_id`, `duration_ms`, `success`, `error?` | A tool has finished executing. |
| `budget:threshold_reached` | `run_id`, `threshold_pct`, `cost_usd`, `budget_usd` | Cost has crossed a budget threshold (50%, 75%, 90%, 100%). |
| `model:resolved` | `run_id`, `node_id`, `agent_id`, `original_model`, `resolved_model`, `reason`, `preference`, `remaining_budget_usd?` | A model identifier has been resolved (e.g., via budget-aware fallback). |

All events include a `timestamp` field (Unix ms).

### Terminal events

Terminal events carry the full `WorkflowState` in their `state` field. Use the `isTerminalEvent()` type guard to narrow the union:

| Event | Fields | Description |
|-------|--------|-------------|
| `workflow:complete` | `state`, `duration_ms` | Workflow finished successfully. |
| `workflow:failed` | `state`, `error` | Workflow failed with an unrecoverable error. |
| `workflow:timeout` | `state`, `elapsed_ms` | Workflow exceeded `max_execution_time_ms`. |
| `workflow:waiting` | `state`, `waiting_for` | Workflow paused for human input (HITL). |

```typescript
import { isTerminalEvent } from '@cycgraph/orchestrator';

if (isTerminalEvent(event)) {
  // TypeScript knows event.state exists here
  console.log(event.state.status);
}
```

## Token streaming

The `agent:token_delta` event delivers individual tokens as they arrive from the LLM. This enables typewriter-style output in CLIs and real-time display in web UIs:

```typescript
for await (const event of runner.stream()) {
  if (event.type === 'agent:token_delta') {
    process.stdout.write(event.token);
  }
}
```

Token deltas are only emitted for agent nodes that use `streamText` (the default execution mode).

## Tool call streaming

The `tool:call_start` and `tool:call_finish` events fire in real-time as tools execute within an agent node. These events are powered by the AI SDK's `experimental_onToolCallStart` and `experimental_onToolCallFinish` callbacks, so they fire *during* the LLM interaction — not post-hoc.

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

Tool call events are also available via the event listener API (see below).

## Memory diffs

The `action:applied` event includes an optional `memory_diff` field that shows exactly which memory keys were added, changed, or removed by the action. This enables real-time UIs to display state changes without polling or comparing full snapshots.

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

The `MemoryDiff` type is exported from `@cycgraph/orchestrator`:

| Field | Type | Description |
|-------|------|-------------|
| `added` | `string[]` | Keys that were added (not present before). |
| `changed` | `string[]` | Keys whose values changed. |
| `removed` | `string[]` | Keys that were removed. |
| `values` | `Record<string, unknown>` | New values for added and changed keys. |

When no memory keys changed (e.g., `goto_node` or `set_status` actions), `memory_diff` is `undefined` — no overhead is incurred.

## Forwarding events over SSE

`stream()` returns an async iterable, which maps directly to a Server-Sent Events handler. Below is a minimal Express endpoint that streams every workflow event to a connected client:

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

WebSocket transports follow the same shape — replace `res.write` with `socket.send` and serialize each event as JSON. Because terminal events carry the full `WorkflowState`, clients can compute the final result without polling.

## Event listeners (non-streaming)

When using `run()` instead of `stream()`, you can still observe events via the `EventEmitter`-style API:

```typescript
const runner = new GraphRunner(graph, state, options);

runner.on('node:start', ({ node_id, type }) => {
  console.log(`Node started: ${node_id} (${type})`);
});

runner.on('budget:threshold_reached', ({ threshold_pct }) => {
  console.warn(`${threshold_pct}% of budget used`);
});

const finalState = await runner.run();
```

Both APIs emit the same events. Use `stream()` when you need to consume events as an async iterable (e.g., forwarding to a client over SSE/WebSocket). Use `run()` with `.on()` when you just need side-effect logging.

## Next steps

- [Cost & Budget Tracking](/docs/concepts/cost-tracking/) — budget threshold events
- [Nodes](/docs/concepts/nodes/) — what each node type emits during execution
- [Error Handling](/docs/concepts/error-handling/) — failure and timeout events
