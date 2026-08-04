---
title: Graph Runner
description: The execution engine that runs a graph, drives the state loop, and handles persistence, streaming, and recovery.
---

The **`GraphRunner`** is the execution engine. You hand it a [graph](/docs/concepts/graphs/) and an initial [workflow state](/docs/concepts/workflow-state/), and it runs the graph node by node, merging each result back into state through the reducers and routing along the edges until it reaches an end node. Everything else in the orchestrator is either an input to a run agents, tools, memory or a place a run writes to, such as persistence, event log, streams.

## How it works

Each run is a loop over nodes. The runner executes the start node, drives it to an action, and dispatches that action through the reducers to produce the next state. It then evaluates the current node's outgoing edges against that new state to pick the next node, and repeats. The loop ends when it reaches a declared end node, exhausts its maximum iterations, or a failure halts it.

State is the only thing that moves between nodes, so the runner can persist a complete snapshot after every step. And every state transition is recorded in the event log, so a crashed run can be rebuilt by replaying those actions through the same reducers. The [durable execution](#durable-execution) section covers both.

A run is single-writer: one runner owns one run at a time. In production you don't construct runners by hand for each request. A [`workflow worker`](/docs/concepts/distributed-execution/) pulls jobs from a queue and runs each one for its whole lifetime, with run fencing to keep two workers off the same run.

## Running a graph

Two entry points execute a run. Both drive the same loop; they differ only in what you observe.

### run

Executes to completion and resolves with the final [`workflow state`](/docs/concepts/workflow-state/). Use it for fire-and-forget execution and worker processes.

```typescript
const finalState = await runner.run();
```

### stream

Yields a [`stream event`](/docs/concepts/streaming/) at each step: token deltas, node transitions, memory diffs, and a terminal event carrying the full final state.

```typescript
for await (const event of runner.stream()) {
  if (event.type === 'agent:token_delta') process.stdout.write(event.token);
  if (event.type === 'workflow:complete') console.log(event.state.status);
}
```

See [Streaming](/docs/concepts/streaming/) for the full event catalogue and SSE forwarding. `GraphRunner` also extends `EventEmitter`, so non-streaming consumers can attach listeners for the same events.

## Stopping a run

Two methods stop an in-flight run, and they mean different things.

### cancel

Aborts immediately. It signals the shared abort controller to cancel any in-flight LLM call, then transitions the run to `cancelled`. Use it when the result is no longer wanted.

```typescript
runner.cancel();
```

### shutdown

Stops gracefully. The current node finishes, its state is persisted, and the run pauses in a resumable state, emitting a `workflow:paused` event. Use it for deploys and scaling down, so a long run can resume later from its last checkpoint rather than restart.

```typescript
const resultPromise = runner.run();

runner.shutdown();
const pausedState = await resultPromise;
```

## Durable execution

Wire an [`EventLogWriter`](/docs/concepts/persistence/#eventlogwriter) and the runner records every action as it runs, so a crashed run can be rebuilt exactly.

```typescript
const runner = new GraphRunner(graph, state, {
  eventLog: myEventLog,
  persistStateFn: async (s) => persistence.saveWorkflowSnapshot(s),
});
```

The `GraphRunner.recover` rebuilds a ready-to-continue runner from a run's event log. It loads the latest checkpoint, replays only the events after it through the same reducers, and returns a runner you can call `.run()` on to continue. Replay makes **no LLM calls**: the stored `Action` objects already hold every agent output, so replay is deterministic and reconstructs identical state, including approval deadlines.

```typescript
const runner = await GraphRunner.recover(graph, runId, eventLog, {
  persistStateFn: async (s) => persistence.saveWorkflowSnapshot(s),
});
const finalState = await runner.run(); // continues from where it left off
```

`compactEvents()` checkpoints the current state and deletes the events behind it, returning the number removed. This keeps a long run's log bounded. It also runs automatically every `compactionInterval` events (default 1000) when an event log is wired. See [Persistence](/docs/concepts/persistence/#event-log-recovery) for the recovery and compaction flow, and [Error Handling](/docs/concepts/error-handling/#event-log-recovery) for the corruption guarantees.

## Persistence

The runner writes state through callbacks rather than a storage object, so it stays free of any database dependency. Pass `persistStateFn` to persist a full snapshot after every step, and optionally `persistDeltaFn` to send compact patches for the steps in between. See [Persistence](/docs/concepts/persistence/#wiring-persistence-into-the-runner) for the wiring, failure escalation, the event-log write barrier, and differential persistence.

## API

### `GraphRunner(graph, state, options?)`

Create a runner for one run. It resumes from a checkpoint when `state.visited_nodes` is non-empty, so the same constructor starts a fresh run or continues a recovered one.

```typescript
GraphRunner(graph: Graph, initialState: WorkflowState, options?: GraphRunnerOptions)
```

##### Options

The options are [`GraphRunnerOptions`](#graphrunneroptions). The [Configuration Reference](/docs/operations/configuration/#graphrunner-options) carries the full table with types and defaults.

### `run`

Execute the graph to completion and resolve with the final state. Consumes `stream()` internally and preserves the original error types.

```typescript
run(): Promise<WorkflowState>
```

### `stream`

Execute the graph, yielding a [`StreamEvent`](/docs/concepts/streaming/) at each step. Pass an `AbortSignal` to cancel mid-run. The terminal `workflow:complete` event carries the full final state.

```typescript
stream(options?: { signal?: AbortSignal }): AsyncGenerator<StreamEvent>
```

### `GraphRunner.recover`

Static. Rebuild a ready-to-continue runner from a run's event log by deterministic replay, making no LLM calls. Throws if no events exist for the run.

```typescript
GraphRunner.recover(
  graph: Graph,
  runId: string,
  eventLog: EventLogWriter,
  options?: Omit<GraphRunnerOptions, 'eventLog'>,
): Promise<GraphRunner>
```

### `compactEvents`

Checkpoint the current state, delete the events at or before it, and return the number removed.

```typescript
compactEvents(): Promise<number>
```

### `cancel`

Abort the run immediately: cancel in-flight LLM calls and transition to `cancelled`.

```typescript
cancel(): void
```

### `shutdown`

Request graceful shutdown. The current node finishes, state is persisted, and the run pauses in a resumable state, emitting `workflow:paused`.

```typescript
shutdown(): void
```

### `getState`

Return a read-only view of the current state. Useful for inspecting a runner before or after a run, such as reconciling a recovered runner against the latest snapshot.

```typescript
getState(): Readonly<WorkflowState>
```

## Interfaces

### GraphRunnerOptions

Constructor options. Every field is optional; the defaults give an in-memory, single-process run with no persistence. Types and defaults for each field are in the [Configuration Reference](/docs/operations/configuration/#graphrunner-options).

| Field | Purpose |
|-------|---------|
| `persistStateFn` | Persist a full state snapshot after each step. Wire to a [`PersistenceProvider`](/docs/concepts/persistence/#persistenceprovider). |
| `persistDeltaFn` | Persist compact [`StatePatch`](/docs/concepts/persistence/#statepatch) diffs between full snapshots. |
| `deltaTrackerOptions` | Tune the delta tracker: `fullSnapshotInterval`, `maxPatchBytes`. |
| `eventLog` | [`EventLogWriter`](/docs/concepts/persistence/#eventlogwriter) for durable, replayable execution. Defaults to an in-memory no-op. |
| `compactionInterval` | Events between automatic event-log compactions. Default `1000`; `0` disables. |
| `loadGraphFn` | Load subgraph definitions by ID for subgraph nodes. |
| `tools` | Provide tools: `defineTool()` results and MCP resolvers, in one array. See [Tools & MCP](/docs/concepts/tools-and-mcp/). |
| `modelResolver` | Budget-aware model selection for agents with a `model_preference`. |
| `contextCompressor` | Compress memory before prompt injection ([Context Engine](/docs/concepts/context-engine/)). |
| `memoryRetriever` | Inject facts from the [memory graph](/docs/concepts/memory/) for nodes declaring a `memory_query`. |
| `memoryWriter` | Persist facts from `reflection` nodes. Required when the graph has one. |
| `factSanitizer` / `factSanitizerFailMode` | Pre-write hook on reflection facts, and its fail-closed behavior. |
| `fitnessFunction` | Deterministic fitness evaluator for `evolution` nodes. |
| `rateLimiter` | Awaited before every LLM call to pace a run inside a provider budget. |
| `securityPolicy` | Taint-aware policy consulted before each node runs. |
| `middleware` | `beforeNodeExecute` / `afterReduce` hooks ([Middleware](/docs/concepts/middleware/)). |
| `onToken` | Callback for each token delta from agent nodes. |
| `autoRollback` | Run saga compensations on failure, transitioning to `cancelled` instead of `failed`. |
| `allowImplicitCompletion` | Restore the legacy behavior of completing silently at a dead-end node instead of failing with `NoMatchingEdgeError`. |

## Next steps

- [Workflow State](/docs/concepts/workflow-state/): the state object a run reads and writes
- [Streaming](/docs/concepts/streaming/): the event stream `stream()` produces
- [Persistence](/docs/concepts/persistence/): wiring snapshots, event logs, and recovery
- [Distributed Execution](/docs/concepts/distributed-execution/): running graphs across worker processes
- [Configuration Reference](/docs/operations/configuration/#graphrunner-options): the full options table
