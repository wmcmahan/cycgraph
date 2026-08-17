---
title: Persistence
description: Storage interfaces for graphs, workflow state, event logs, usage records, and data retention.
---

The orchestrator depends only on **interfaces** for storage. Concrete implementations are injected at startup. This means you can run entirely in-memory for development and testing, then swap in Postgres (or any other backend) for production without changing application code.

```bash
npm install @cycgraph/orchestrator-postgres
```

## Wiring persistence into the runner

The [`GraphRunner`](/docs/concepts/graph-runner/) writes state through injected callbacks rather than a storage object, which is what keeps the core package free of any database dependency. Pass `persistState` to persist a snapshot after every state mutation:

```typescript
const runner = new GraphRunner(graph, state, {
  persistState: async (state) => {
    await persistence.saveWorkflowSnapshot(state);
  },
});
```

See the [Graph Runner](/docs/concepts/graph-runner/) page for the runner's full API and lifecycle, and the [Configuration Reference](/docs/operations/configuration/#graphrunner-options) for every option.

### Persistence failure escalation

The GraphRunner tracks consecutive persistence failures. If `persistState` fails 3 times in a row, the runner throws a `PersistenceUnavailableError` rather than silently continuing with divergent in-memory and storage state. The counter resets on any successful persist call.

### Event-log write barrier

Event appends overlap with node execution (no per-event latency), but every `persistState` call is preceded by a **flush barrier**: the runner awaits all outstanding event appends *before* the state snapshot commits. The event log is the snapshot's history. A snapshot must never exist whose events were silently lost, or event-log recovery would reconstruct an older state and re-execute nodes whose side effects already happened.

Failure semantics mirror snapshots: a flush containing failures counts one strike, and three consecutive failed flushes halt the workflow. Two errors are **immediately fatal**, bypassing the strike budget, because both mean another writer is executing the same run:

- `EventSequenceConflictError`: an append collided with an existing `(run_id, sequence_id)`. The `append()` contract *rejects* duplicates (both `InMemoryEventLogWriter` and `DrizzleEventLogWriter`) instead of silently dropping or double-storing them.
- `StaleClaimError`: a fenced write carried an outdated claim epoch (see [Run fencing](/docs/concepts/distributed-execution/#run-fencing)).

Each snapshot also records the event-log high-water mark it was persisted under (`_last_event_sequence_id`), which resume logic uses to decide whether a logged action's effects are already contained in the snapshot.

### Loading state: hydration

State snapshots round-trip through JSON/jsonb, which turns every `Date` into a string. All built-in loaders (`loadLatestWorkflowState`, checkpoint loads, recovery) pass loaded state through `hydrateWorkflowState()`, which:

1. Applies any pending schema migrations (states carry a `state_schema_version`; snapshots from a *newer* engine version are refused with a clear error)
2. Parses with `WorkflowStateSchema`, coercing temporal fields back to real `Date` objects and failing loudly on structurally invalid state

If you implement a custom `PersistenceProvider` or `EventLogWriter`, call `hydrateWorkflowState()` (exported from `@cycgraph/orchestrator`) on every state you load from storage. Handing the runner a raw JSON clone leaves date comparisons silently broken, such as approval-gate timeouts that never fire.

**Refs:**
- [PersistenceProvider](#persistenceprovider): The primary storage contract behind `persistState`.
- [EventLogWriter](#eventlogwriter): The durable event log the write barrier flushes.
- [hydrateWorkflowState](#hydrateworkflowstate): Parse and migrate loaded state at the boundary.

## Replaying the event log

`loadEvents(run_id)` returns the raw, ordered event rows for a run. Use it to inspect what happened during execution, replay actions through reducers in test code, or rebuild state for a debugger UI.

```typescript
import type { WorkflowEvent } from '@cycgraph/orchestrator';

const events = await persistence.loadEvents(runId);

for (const event of events) {
  console.log(
    `[seq=${event.sequence_id}] ${event.event_type} (${event.node_id ?? '—'})`
  );
}

// Reconstruct the actions that drove state transitions
const actions = events
  .filter((e) => e.event_type === 'action_dispatched')
  .map((e) => e.action);
```

For full crash recovery, prefer `GraphRunner.recover()`. It handles checkpoints, gap validation (contiguous sequence ids, throwing `EventLogCorruptionError` on a lost append), replay-version checks, and reducer replay automatically. Replay is deterministic: reducers derive all timestamps from the stored action metadata, so replaying the same log always reconstructs the same state, including approval deadlines. Use `loadEvents()` directly when you need raw access for tooling or post-hoc analysis.

**Refs:**
- [WorkflowEvent](#workflowevent): The shape of one event-log row.
- [Event-log recovery](#event-log-recovery): `GraphRunner.recover` and `compactEvents`.

## State versioning

Every call to `saveWorkflowState()` creates a new version. This enables:

- **Crash recovery.** `loadLatestWorkflowState()` returns the most recent snapshot.
- **State history.** `loadWorkflowStateHistory()` lists all versions for debugging.
- **Time travel.** `loadWorkflowStateAtVersion()` loads full state at any version.

`loadLatestWorkflowState()` sorts by `version` (not `created_at`) to handle sub-millisecond state saves correctly. Multiple state saves within the same millisecond are common during parallel node execution, so version ordering is the only reliable way to identify the latest state.

## Differential state persistence

For long-running workflows with large memory, persisting the full `WorkflowState` on every step can be expensive. cycgraph provides a `StateDeltaTracker` that computes diffs between consecutive state snapshots and persists only what changed.

### Setup

```typescript
import { GraphRunner, StateDeltaTracker } from '@cycgraph/orchestrator';

const runner = new GraphRunner(graph, state, {
  persistState: async (state) => {
    // Full snapshots go here
    await persistence.saveWorkflowSnapshot(state);
  },
  persistDelta: async (patch) => {
    // Compact patches go here
    await persistence.saveDelta(patch);
  },
  deltaTrackerOptions: {
    fullSnapshotInterval: 10,  // Full snapshot every 10 persists
    maxPatchBytes: 50_000,     // Fall back to full if patch > 50KB
  },
});
```

### How it works

The delta tracker compares each state to the previously persisted snapshot and produces a [`StatePatch`](#statepatch): the changed scalar fields, the memory keys added or updated with their new values, and the memory keys removed.

A full snapshot is automatically emitted:
- On the first persist (no previous state to diff against)
- Every `fullSnapshotInterval` persists (default: 10)
- When the computed patch exceeds `maxPatchBytes` (default: 50KB)

This ensures recovery never requires replaying a long chain of patches.

### Without delta tracking

When `persistDelta` is not provided, all persists use `persistState` (full snapshots). Delta tracking is entirely opt-in.

**Refs:**
- [`StateDeltaTracker`](#statedeltatracker): Computes the diffs and decides full-vs-patch.
- [StatePatch](#statepatch): The compact diff shape handed to `persistDelta`.

## Event log compaction

Long-running workflows accumulate events in the event log. The `GraphRunner` supports automatic compaction to prevent unbounded growth:

```typescript
const runner = new GraphRunner(graph, state, {
  eventLog: myEventLog,
  compactionInterval: 100, // Checkpoint and compact every 100 events
});
```

When `compactionInterval` is set, the runner automatically:
1. Saves a checkpoint (state snapshot at the current sequence ID)
2. Deletes all events at or before the checkpoint

This is best-effort: compaction failures are logged but don't halt the workflow. You can also trigger compaction manually:

```typescript
const deleted = await runner.compactEvents();
console.log(`Compacted ${deleted} events`);
```

:::caution[Compaction bounds what you can replay]
Compaction deletes the events behind its checkpoint, so anything that reads the
log for a position earlier than that no longer can. Crash recovery is unaffected, and it resumes from the checkpoint.
:::

## Run lineage

A run can come from another run. `workflow_runs` records which:

| Column | Meaning |
|--------|---------|
| `run_kind` | `primary`, `subgraph`, or `counterfactual` |
| `parent_run_id` | The run this one came from |
| `fork_sequence_id` | Where in the parent a counterfactual diverged |
| `fork_mutations` | The serialized changes it applied, so the fork is reproducible from its row |
| `fork_group_id` | Ties one sweep's variants together |

`run_kind` exists because `parent_run_id` alone is ambiguous: subgraph child runs have used it since before forking existed. Analytics and retention filter on it so counterfactual spend stays out of production numbers unless asked for. `usage_records` references `workflow_runs`, so excluding fork spend is a join rather than a denormalized column:

```sql
SELECT sum(cost_usd) FROM usage_records u
JOIN workflow_runs r ON r.id = u.run_id
WHERE r.run_kind = 'primary';
```

Lineage is written separately from `saveWorkflowRun` because it is not derivable from `WorkflowState`: it describes where a run came from, not what it holds. Keeping it out of the state schema also keeps it out of event replay.

## API

### In-memory implementations

Zero-dependency implementations for development and testing, backed by `Map` objects and exported from `@cycgraph/orchestrator`.

| Class | Implements | Notes |
|-------|-----------|-------|
| `InMemoryPersistenceProvider` | [`PersistenceProvider`](#persistenceprovider) | Graphs, runs, versioned state snapshots, and event rows. |
| `InMemoryAgentRegistry` | [`AgentRegistry`](#agentregistry) | `register()` plus the optional CRUD methods. |
| `InMemoryMCPServerRegistry` | [`MCPServerRegistry`](#mcpserverregistry) | Re-validates entries on read and write. |
| `InMemoryWorkflowQueue` | [`WorkflowQueue`](#workflowqueue) | In-process job queue for local worker runs. |
| `InMemoryEventLogWriter` | [`EventLogWriter`](#eventlogwriter) | Durable-replay event log for tests. |
| `NoopEventLogWriter` | [`EventLogWriter`](#eventlogwriter) | Discards writes. The default when no event log is provided. |

```typescript
import {
  InMemoryPersistenceProvider,
  InMemoryAgentRegistry,
  InMemoryMCPServerRegistry,
  InMemoryWorkflowQueue,
} from '@cycgraph/orchestrator';

const persistence = new InMemoryPersistenceProvider();
const agents = new InMemoryAgentRegistry();
const mcpServers = new InMemoryMCPServerRegistry();
const queue = new InMemoryWorkflowQueue();
```

### Postgres implementations

Production-grade Drizzle ORM implementations from `@cycgraph/orchestrator-postgres`, each satisfying the same interface as its in-memory counterpart.

| Class | Implements |
|-------|-----------|
| `DrizzlePersistenceProvider` | [`PersistenceProvider`](#persistenceprovider) |
| `DrizzleAgentRegistry` | [`AgentRegistry`](#agentregistry) |
| `DrizzleMCPServerRegistry` | [`MCPServerRegistry`](#mcpserverregistry) |
| `DrizzleEventLogWriter` | [`EventLogWriter`](#eventlogwriter) |
| `DrizzleWorkflowQueue` | [`WorkflowQueue`](#workflowqueue) |
| `DrizzleUsageRecorder` | [`UsageRecorder`](#usagerecorder) |
| `DrizzleRetentionService` | [`RetentionService`](#retentionservice) |

`DrizzleWorkflowQueue` claims jobs with `FOR UPDATE SKIP LOCKED` and carries fencing epochs. See [Distributed Execution](/docs/concepts/distributed-execution/).

```typescript
import { DrizzlePersistenceProvider, DrizzleAgentRegistry } from '@cycgraph/orchestrator-postgres';
```

### `StateDeltaTracker`

Computes diffs between consecutive state snapshots for [differential persistence](#differential-state-persistence). It emits a compact [`StatePatch`](#statepatch) when it can, and a full snapshot on the first persist, at the interval, or when a patch would exceed the size cap.

```typescript
new StateDeltaTracker(options?: StateDeltaTrackerOptions)
```

##### Options

| Parameter | Type | Default | Description |
|--------|------|---------|-------------|
| `fullSnapshotInterval` | `number` | `10` | Persists between forced full snapshots. |
| `maxPatchBytes` | `number` | `50000` | Emit a full snapshot instead when a patch exceeds this estimated size. |

### `hydrateWorkflowState`

Parse a persisted state at a load boundary: run pending schema migrations, then parse with `WorkflowStateSchema`, coercing temporal fields back to `Date`. Every custom `PersistenceProvider` or `EventLogWriter` must call it on state loaded from storage.

```typescript
hydrateWorkflowState(raw: unknown): WorkflowState
```

See [Workflow State](/docs/concepts/workflow-state/#hydrateworkflowstate) for the full contract.

### Event-log recovery

Rebuild a ready-to-continue runner from a durable event log, or trim a log that has grown large.

```typescript
GraphRunner.recover(graph, runId, eventLog, options?): Promise<GraphRunner>
runner.compactEvents(): Promise<number>
```

`recover` loads the latest checkpoint, replays only the events after it through the same reducers, and validates that the log is gap-free, throwing `EventLogCorruptionError` on a lost append. `compactEvents` checkpoints the current state, deletes events at or before it, and returns the number removed. See [Error Handling](/docs/concepts/error-handling/#event-log-recovery) for the recovery flow.

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
| `saveRunLineage(id, lineage)?` | Record that a run was forked from another, and what it changed. Optional — a provider that does not model lineage omits it. |
| `saveWorkflowState(state)` | Save a state snapshot (auto-incremented version). |
| `saveWorkflowSnapshot(state)` | Atomically save both the run record and state snapshot in a single transaction. Required on all implementations. |
| `loadLatestWorkflowState(run_id)` | Load the most recent state for crash recovery. |
| `loadWorkflowStateHistory(run_id, opts?)` | Load version history (lightweight summaries). |
| `loadWorkflowStateAtVersion(run_id, version)` | Load full state at a specific version. |
| `loadEvents(run_id)` | Load raw event rows for a run. |

### AgentRegistry

Stores and retrieves agent configurations. The `register()` method auto-generates UUIDs.

| Method | Description |
|--------|-------------|
| `register(input)` | Register an agent config (`AgentRegistryInput`, no `id` field). Returns the auto-generated UUID. |
| `loadAgent(id)` | Load an agent config by ID. Returns `null` if not found. |
| `updateAgent(id, updates)` | *(optional)* Update an existing agent's configuration fields. |
| `listAgents(opts?)` | *(optional)* List registered agents with optional `limit`/`offset` pagination. |
| `deleteAgent(id)` | *(optional)* Delete an agent by ID. Returns `true` if deleted, `false` if not found. |

Both `InMemoryAgentRegistry` and `DrizzleAgentRegistry` implement the full `AgentRegistry` interface, including `register()` and the optional CRUD methods.

### MCPServerRegistry

Trusted store for MCP server transport configurations. See [Tools & MCP](/docs/concepts/tools-and-mcp/) for details.

| Method | Description |
|--------|-------------|
| `saveServer(entry)` | Register or update a server entry. |
| `loadServer(id)` | Load a server by ID. |
| `listServers()` | List all registered servers. |
| `deleteServer(id)` | Remove a server. |

### WorkflowQueue

Job queue for [distributed execution](/docs/concepts/distributed-execution/). Workers poll for jobs, process them via `GraphRunner`, and report results.

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

### EventLogWriter

The append-only event log behind event-sourced replay. `NoopEventLogWriter` (the default) discards writes, while `InMemoryEventLogWriter` and `DrizzleEventLogWriter` persist them.

| Method | Description |
|--------|-------------|
| `append(event)` | Append one event. Throws `EventSequenceConflictError` on a duplicate `(run_id, sequence_id)`. |
| `loadEvents(run_id)` | Load all events for a run, ordered by `sequence_id`. |
| `loadEventsAfter(run_id, afterSequenceId)` | Load events after a sequence id (checkpoint-accelerated recovery). |
| `getLatestSequenceId(run_id)` | Highest `sequence_id` for a run, or `-1` if none. |
| `checkpoint(run_id, sequenceId, state)` | Save a state snapshot at a sequence id. |
| `loadCheckpoint(run_id)` | Load the latest checkpoint, or `null`. |
| `compact(run_id, beforeSequenceId)` | Delete events at or before a sequence id. Returns the count removed. |

### UsageRecorder

Persists per-run cost and token usage for billing and observability.

| Method | Description |
|--------|-------------|
| `saveUsageRecord(record)` | Persist a [`UsageRecord`](#usagerecord). |

### RetentionService

Manages workflow data lifecycle across Hot / Warm / Cold tiers.

| Method | Description |
|--------|-------------|
| `archiveCompletedWorkflows()` | Move completed runs from Hot to Warm tier. |
| `deleteWarmData()` | Delete Warm data older than the retention period. |
| `getStorageStats()` | Get per-tier run counts. |

### StatePatch

A compact diff between two consecutive state snapshots, emitted by [`StateDeltaTracker`](#statedeltatracker) and handed to `persistDelta`.

| Field | Type | Description |
|-------|------|-------------|
| `run_id` | `string` | Which run this patch applies to. |
| `version` | `number` | Auto-incremented version number. |
| `fields` | `Record<string, unknown>` | Changed scalar fields (`status`, `current_node`, and the like). |
| `memory_updates` | `Record<string, unknown>` | Memory keys added or changed, with new values. |
| `memory_removals` | `string[]` | Memory keys removed. |

### WorkflowEvent

One row in the event log. `run_id` plus `sequence_id` uniquely identifies it and defines replay order.

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` (UUID) | Unique event identifier. |
| `run_id` | `string` (UUID) | Run this event belongs to. |
| `sequence_id` | `number` | Monotonic position in the run's log. |
| `event_type` | `EventType` | Event kind, such as `'action_dispatched'`. |
| `node_id` | `string?` | Node that produced the event. |
| `action` | `Action?` | The dispatched action, for `'action_dispatched'` events. |
| `created_at` | `Date` | When the event was written. |

`NewWorkflowEvent` is the same shape without `id` and `created_at`, which the writer generates.

### UsageRecord

A per-run cost and token record persisted by [`UsageRecorder`](#usagerecorder).

| Field | Type | Description |
|-------|------|-------------|
| `run_id` | `string` | Run that incurred the usage. |
| `graph_id` | `string` | Graph that was executed. |
| `input_tokens` | `number` | Prompt tokens consumed. |
| `output_tokens` | `number` | Completion tokens consumed. |
| `cost_usd` | `number` | Estimated cost in USD. |
| `duration_ms` | `number` | Wall-clock duration. |
| `api_key_id` | `string?` | API key used, when applicable. |
| `model_breakdown` | `Record<string, { input_tokens, output_tokens, cost_usd, calls }>?` | Per-model token and cost attribution. |

### WorkflowJob

A queued unit of work a worker claims and runs. Enqueue with the smaller `EnqueueJobInput` shape (`type`, `run_id`, `graph_id`, plus optional `priority`, `max_attempts`, and `visibility_timeout_ms`); the queue fills the rest.

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` (UUID) | Job identifier. |
| `type` | `'start'` \| `'resume'` | Start a new run, or resume after a crash or HITL pause. |
| `run_id` / `graph_id` | `string` (UUID) | Run and graph the job drives. |
| `status` | `WorkflowJobStatus` | `waiting`, `active`, `paused`, `completed`, `failed`, or `dead_letter`. |
| `priority` | `number` | Lower values are dequeued first. |
| `attempt` / `max_attempts` | `number` | Retry accounting before dead-lettering. |
| `visibility_timeout_ms` | `number` | Reclaim window for a crashed worker. |
| `claim_epoch` | `number?` | Fencing token that rejects stale-worker writes. |

## Next steps

- [Workflow State](/docs/concepts/workflow-state/): the state object that gets persisted
- [Cost & Budget Tracking](/docs/concepts/cost-tracking/): usage recording interface
- [Error Handling](/docs/concepts/error-handling/): crash recovery and event replay
