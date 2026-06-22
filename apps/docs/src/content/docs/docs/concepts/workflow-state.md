---
title: Workflow State
description: The shared state object that all nodes read from and write to.
---

The **WorkflowState** is the single source of truth for a running workflow. Every node reads from it, writes to it, and the engine persists it after each step for crash recovery.

## Creating state

State is **authored in camelCase** via `createWorkflowState`. The runtime state object below is snake_case (the engine reads and the database stores that wire format), so the **Schema reference** fields you read back are snake_case.

```typescript
import { createWorkflowState } from '@cycgraph/orchestrator';

const state = createWorkflowState({
  workflowId: graph.id,
  goal: 'Research and summarize quantum computing',
  constraints: ['Under 500 words'],
  maxExecutionTimeMs: 120_000,
});

// Read back uses the snake_case runtime shape:
state.workflow_id; // string
state.iteration_count; // number
```

## Schema reference (runtime / read shape — snake_case)

### Identity and input

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `workflow_id` | `string` (UUID) | *required* | Graph definition this run belongs to. |
| `run_id` | `string` (UUID) | auto-generated | Unique identifier for this execution. |
| `goal` | `string` | *required* | High-level objective for the workflow. |
| `constraints` | `string[]` | `[]` | Rules the workflow must respect. |

### Control flow

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `status` | `WorkflowStatus` | `'pending'` | Current lifecycle status. |
| `current_node` | `string` | — | Node currently being executed. |
| `iteration_count` | `number` | `0` | Total reducer dispatches so far (loop guard). |
| `max_iterations` | `number` | `50` | Hard cap — the run fails if exceeded. |
| `started_at` | `Date` | — | When `run()` was first invoked. |
| `max_execution_time_ms` | `number` | `3600000` (1h) | Wall-clock timeout for the entire run. |

### Retry and resilience

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `retry_count` | `number` | `0` | Retries on the current node so far. |
| `max_retries` | `number` | `3` | Maximum retries before the node fails permanently. |
| `last_error` | `string` | — | Error message from the most recent failure. |
| `compensation_stack` | `CompensationEntry[]` | `[]` | Stack of typed compensating actions for saga rollback. Each entry has `action_id` and `compensation_action: { type, payload }`. |

### Waiting (human-in-the-loop)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `waiting_for` | `WaitingReason` | — | Why the workflow is paused (e.g. `'human_approval'`). |
| `waiting_since` | `Date` | — | When the workflow entered the waiting state. |
| `waiting_timeout_at` | `Date` | — | Deadline after which the wait times out. |

### Cost and token tracking

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `total_tokens_used` | `number` | `0` | Cumulative tokens consumed across all LLM calls. |
| `max_token_budget` | `number` | — | If set, the run fails when token usage exceeds this. |
| `total_cost_usd` | `number` | `0` | Cumulative estimated cost in USD. |
| `budget_usd` | `number` | — | Per-run cost budget (run fails when exceeded). |

### Memory and tracking

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `memory` | `Record<string, unknown>` | `{}` | Shared key-value store. See [Memory](#memory) below. |
| `visited_nodes` | `string[]` | `[]` | Node IDs visited in execution order. |
| `supervisor_history` | `object[]` | `[]` | Routing decisions made by supervisor nodes (for debugging). |
| `created_at` | `Date` | now | When this run was created. |
| `updated_at` | `Date` | now | Last state mutation timestamp. |

### Persistence bookkeeping (runner-managed)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `state_schema_version` | `number` | `1` | Schema version of this state shape. Loaded snapshots pass through `hydrateWorkflowState()`, which migrates older versions forward and refuses snapshots from a newer engine. |
| `_last_event_sequence_id` | `number` | — | Event-log high-water mark at the moment the snapshot was persisted. Resume logic uses it to decide whether a logged action's effects are already inside the snapshot (crash-window idempotency). |

These fields are managed by the runner — don't set them by hand. All temporal fields use coercing schemas (`z.coerce.date()`), so states loaded from JSON/jsonb storage hydrate back to real `Date` objects.

### Status lifecycle

The workflow status transitions denote the lifecycle of a workflow. The terminal states (`completed`, `failed`, `cancelled`, `timeout`) are final: a transition guard **enforces** that a terminal run can never return to an active status, so a stray `set_status` (or a replayed `_init` on a recovered run) can't resurrect a dead run. The one terminal→terminal move that is allowed is saga rollback, which moves a `failed`/`timeout` run to `cancelled` after its compensations run.

```mermaid
stateDiagram-v2
    direction LR
    pending --> scheduled
    scheduled --> running
    running --> completed
    running --> waiting
    running --> retrying
    waiting --> running
    retrying --> running
    retrying --> failed
    running --> cancelled
    running --> timeout
    failed --> cancelled: saga rollback
    timeout --> cancelled: saga rollback
```

The guard is exposed as `canTransitionStatus(from, to)` / `isTerminalStatus(status)` / `TERMINAL_STATUSES` from `@cycgraph/orchestrator` if you need to check legality yourself.

---

## Memory

The `memory` object is the primary data exchange between nodes. It's an arbitrary key-value store — you define the keys based on your workflow's needs. Agents write to it via their text output, which the orchestrator automatically routes to the node's write key. For agents that need to write structured data to multiple keys, the `save_to_memory` tool can be declared explicitly. Agents read from memory via their filtered state view (controlled by `read_keys` on the node).

- **Use descriptive keys** — `research_notes` is better than `data` or `result`
- **Reference, don't store** — avoid large blobs in memory; store them externally and keep a reference
- **Keep it flat** — deeply nested objects are harder to debug

### Memory layers

| Layer | Scope | Persistence | Purpose |
|-------|-------|-------------|---------|
| **Graph State** | Shared across all nodes | Persisted after every step | Source of truth — goal, results, artifacts |
| **Thread Context** | Local to a single agent | Ephemeral | Raw LLM conversation for the current agent |

**Graph State** is the `memory` object. It's persisted after every node execution, enabling crash recovery and time-travel debugging.

**Thread Context** is the raw LLM conversation history within a single agent execution. Each agent has its own thread — agents don't see each other's raw messages. The orchestrator automatically captures the agent's text output and routes it to the appropriate write key, and the thread is discarded.

## Action types

Actions dispatched to the reducer use a discriminated union type `ActionTypeSchema`. Valid action types are:

| Action Type | Purpose |
|-------------|---------|
| `update_memory` | Write key-value pairs to the memory object |
| `set_status` | Transition the workflow status |
| `goto_node` | Override the next node in the graph |
| `handoff` | Transfer control to another agent/workflow |
| `request_human_input` | Pause for human-in-the-loop approval |
| `resume_from_human` | Inject human response and resume |
| `merge_parallel_results` | Combine results from parallel node execution |

Invalid action types are rejected at parse time via Zod validation. Internal engine actions (prefixed with `_`, such as `_fail`, `_init`, `_budget_exceeded`) bypass this validation and are reserved for the engine.

## Taint tracking

Data entering the system from external tools (web search, file reads) is flagged as **tainted**. Taint propagates automatically — if a node reads tainted data and writes to state, the output key inherits the taint flag. This lets downstream nodes make trust decisions about their inputs.

## Next steps

- [Agents](/docs/concepts/agents/) — how agents read and write state
- [Nodes](/docs/concepts/nodes/) — node types and configuration
