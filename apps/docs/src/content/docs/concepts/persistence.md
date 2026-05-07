---
title: Persistence
description: Storage interfaces for graphs, workflow state, event logs, usage records, and data retention.
---

The orchestrator depends only on **interfaces** for storage — concrete implementations are injected at startup. This means you can run entirely in-memory for development and testing, then swap in Postgres (or any other backend) for production without changing application code.

## Architecture

```
@mcai/orchestrator (interfaces + in-memory implementations)
        │
        └── @mcai/orchestrator-postgres (Drizzle/Postgres implementations)
```

The core `@mcai/orchestrator` package has **zero database dependencies**. All persistence contracts are defined as TypeScript interfaces in `persistence/interfaces.ts`, with in-memory implementations provided for development and testing.

## Interfaces

### PersistenceProvider

The primary storage interface. Covers graph definitions, workflow runs, state snapshots, and event queries.

| Method | Description |
|--------|-------------|
| `saveGraph(graph)` | Save or upsert a graph definition. |
| `loadGraph(id)` | Load a graph by ID. |
| `listGraphs(opts?)` | List graphs, ordered by last update. |
| `saveWorkflowRun(state)` | Save or upsert a run record from current state. |
| `loadWorkflowRun(id)` | Load a run by ID. |
| `listWorkflowRuns(opts?)` | List runs, ordered by creation time. |
| `updateRunStatus(id, status)` | Update only the status of a run. |
| `saveWorkflowState(state)` | Save a state snapshot (auto-incremented version). |
| `saveWorkflowSnapshot(state)` | Atomically save both the run record and state snapshot in a single transaction. Required on all implementations. |
| `loadLatestWorkflowState(run_id)` | Load the most recent state for crash recovery. |
| `loadWorkflowStateHistory(run_id, opts?)` | Load version history (lightweight summaries). |
| `loadWorkflowStateAtVersion(run_id, version)` | Load full state at a specific version. |
| `loadEvents(run_id)` | Load raw event rows for a run. |

### AgentRegistry

Stores and retrieves agent configurations. The `register()` method auto-generates UUIDs:

| Method | Description |
|--------|-------------|
| `register(input)` | Register an agent config (`AgentRegistryInput`, no `id` field). Returns the auto-generated UUID. |
| `loadAgent(id)` | Load an agent config by ID. Returns `null` if not found. |
| `updateAgent(id, updates)` | *(optional)* Update an existing agent's configuration fields. |
| `listAgents(opts?)` | *(optional)* List registered agents with optional `limit`/`offset` pagination. |
| `deleteAgent(id)` | *(optional)* Delete an agent by ID. Returns `true` if deleted, `false` if not found. |

Both `InMemoryAgentRegistry` and `DrizzleAgentRegistry` implement the full `AgentRegistry` interface, including `register()` and the optional CRUD methods.

### MCPServerRegistry

Trusted store for MCP server transport configurations. See [Tools & MCP](/concepts/tools-and-mcp/) for details.

| Method | Description |
|--------|-------------|
| `saveServer(entry)` | Register or update a server entry. |
| `loadServer(id)` | Load a server by ID. |
| `listServers()` | List all registered servers. |
| `deleteServer(id)` | Remove a server. |

### WorkflowQueue

Job queue for [distributed execution](/concepts/distributed-execution/). Workers poll for jobs, process them via `GraphRunner`, and report results.

| Method | Description |
|--------|-------------|
| `enqueue(input)` | Add a job to the queue. Returns the auto-generated job ID. |
| `dequeue(workerId)` | Atomically claim the highest-priority waiting job. |
| `ack(jobId)` | Mark a job as completed. |
| `nack(jobId, error)` | Report failure. Retries if attempts remain, otherwise dead-letters. |
| `heartbeat(jobId, extendMs?)` | Extend visibility timeout during long execution. |
| `release(jobId)` | Transition to `paused` status without incrementing attempt count (for HITL pauses). Paused jobs are not re-claimable by `dequeue`. |
| `reclaimExpired()` | Reclaim jobs with expired visibility timeouts (crash recovery). |
| `getJob(jobId)` | Load a job by ID. |
| `getQueueDepth()` | Count by status: `{ waiting, active, paused, dead_letter }`. |

### UsageRecorder

Persists per-run cost and token usage for billing and observability:

| Method | Description |
|--------|-------------|
| `saveUsageRecord(record)` | Persist a usage record (run_id, tokens, cost, duration). |

### RetentionService

Manages workflow data lifecycle across Hot / Warm / Cold tiers:

| Method | Description |
|--------|-------------|
| `archiveCompletedWorkflows()` | Move completed runs from Hot to Warm tier. |
| `deleteWarmData()` | Delete Warm data older than the retention period. |
| `getStorageStats()` | Get per-tier run counts. |

## In-memory implementations

For development and testing, the core package provides:

- `InMemoryPersistenceProvider` — full `PersistenceProvider` backed by `Map` objects
- `InMemoryAgentRegistry` — agent registry with `register()`, `loadAgent()`, `updateAgent()`, `listAgents()`, and `deleteAgent()`
- `InMemoryMCPServerRegistry` — MCP server registry backed by a `Map`
- `InMemoryWorkflowQueue` — job queue for [distributed execution](/concepts/distributed-execution/)

```typescript
import {
  InMemoryPersistenceProvider,
  InMemoryAgentRegistry,
  InMemoryMCPServerRegistry,
  InMemoryWorkflowQueue,
} from '@mcai/orchestrator';

const persistence = new InMemoryPersistenceProvider();
const agents = new InMemoryAgentRegistry();
const mcpServers = new InMemoryMCPServerRegistry();
const queue = new InMemoryWorkflowQueue();
```

## Postgres implementation

The `@mcai/orchestrator-postgres` package provides production-grade Drizzle ORM implementations:

- `DrizzlePersistenceProvider`
- `DrizzleAgentRegistry`
- `DrizzleMCPServerRegistry`
- `DrizzleEventLogWriter`
- `DrizzleUsageRecorder`
- `DrizzleRetentionService`

```typescript
import { DrizzlePersistenceProvider, DrizzleAgentRegistry } from '@mcai/orchestrator-postgres';
```

## Wiring persistence into the runner

The `GraphRunner` accepts a `persistStateFn` callback that is called after every state mutation:

```typescript
const runner = new GraphRunner(graph, state, {
  persistStateFn: async (state) => {
    await persistence.saveWorkflowSnapshot(state);
  },
});
```

### Persistence failure escalation

The GraphRunner tracks consecutive persistence failures. If `persistStateFn` fails 3 times in a row, the runner throws a `PersistenceUnavailableError` rather than silently continuing with divergent in-memory and storage state. The counter resets on any successful persist call.

## Replaying the event log

`loadEvents(run_id)` returns the raw, ordered event rows for a run. Use it to inspect what happened during execution, replay actions through reducers in test code, or rebuild state for a debugger UI.

```typescript
import type { WorkflowEvent } from '@mcai/orchestrator';

const events = await persistence.loadEvents(runId);

for (const event of events) {
  console.log(
    `[seq=${event.sequence_id}] ${event.event_type} (${event.node_id ?? '—'})`
  );
}

// Reconstruct the actions that drove state transitions
const actions = events
  .filter((e) => e.event_type === 'action_applied')
  .map((e) => e.payload);
```

For full crash recovery, prefer `GraphRunner.recoverFromEventLog()` — it handles checkpoints, sequence integrity checks, and reducer replay automatically. Use `loadEvents()` directly when you need raw access for tooling or post-hoc analysis.

## State versioning

Every call to `saveWorkflowState()` creates a new version. This enables:

- **Crash recovery** — `loadLatestWorkflowState()` returns the most recent snapshot
- **State history** — `loadWorkflowStateHistory()` lists all versions for debugging
- **Time travel** — `loadWorkflowStateAtVersion()` loads full state at any version

`loadLatestWorkflowState()` sorts by `version` (not `created_at`) to handle sub-millisecond state saves correctly. Multiple state saves within the same millisecond are common during parallel node execution, so version ordering is the only reliable way to identify the latest state.

## Differential state persistence

For long-running workflows with large memory, persisting the full `WorkflowState` on every step can be expensive. MC-AI provides a `StateDeltaTracker` that computes diffs between consecutive state snapshots and persists only what changed.

### Setup

```typescript
import { GraphRunner, StateDeltaTracker } from '@mcai/orchestrator';

const runner = new GraphRunner(graph, state, {
  persistStateFn: async (state) => {
    // Full snapshots go here
    await persistence.saveWorkflowSnapshot(state);
  },
  persistDeltaFn: async (patch) => {
    // Compact patches go here
    await persistence.saveDelta(patch);
  },
  deltaTrackerOptions: {
    full_snapshot_interval: 10,  // Full snapshot every 10 persists
    max_patch_bytes: 50_000,     // Fall back to full if patch > 50KB
  },
});
```

### How it works

The delta tracker compares each state to the previously persisted snapshot and produces a `StatePatch`:

| Field | Type | Description |
|-------|------|-------------|
| `run_id` | `string` | Which run this patch applies to. |
| `version` | `number` | Auto-incremented version number. |
| `fields` | `Record<string, unknown>` | Changed scalar fields (status, current_node, etc.). |
| `memory_updates` | `Record<string, unknown>` | Memory keys that were added or changed, with new values. |
| `memory_removals` | `string[]` | Memory keys that were removed. |

A full snapshot is automatically emitted:
- On the first persist (no previous state to diff against)
- Every `full_snapshot_interval` persists (default: 10)
- When the computed patch exceeds `max_patch_bytes` (default: 50KB)

This ensures recovery never requires replaying a long chain of patches.

### Without delta tracking

When `persistDeltaFn` is not provided, all persists use `persistStateFn` (full snapshots). Delta tracking is entirely opt-in.

## Event log compaction

Long-running workflows accumulate events in the event log. The `GraphRunner` supports automatic compaction to prevent unbounded growth:

```typescript
const runner = new GraphRunner(graph, state, {
  eventLog: myEventLog,
  compaction_interval: 100, // Checkpoint and compact every 100 events
});
```

When `compaction_interval` is set, the runner automatically:
1. Saves a checkpoint (state snapshot at the current sequence ID)
2. Deletes all events at or before the checkpoint

This is best-effort — compaction failures are logged but don't halt the workflow. You can also trigger compaction manually:

```typescript
const deleted = await runner.compactEvents();
console.log(`Compacted ${deleted} events`);
```

## Next steps

- [Workflow State](/concepts/workflow-state/) — the state object that gets persisted
- [Cost & Budget Tracking](/concepts/cost-tracking/) — usage recording interface
- [Error Handling](/concepts/error-handling/) — crash recovery and event replay
