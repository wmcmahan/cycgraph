---
title: Error Handling
description: How errors are defined, categorized, and recovered from in cycgraph workflows.
---

The orchestrator has a structured error hierarchy so that every failure mode has a clear type, category, and recovery path. Errors are never swallowed — they either trigger a retry, trip a circuit breaker, or terminate the run with a precise reason.

## Error class hierarchy

| Class | Module | Key Properties | When Thrown |
|-------|--------|---------------|------------|
| `BudgetExceededError` | `runner/errors` | `tokensUsed`, `budget` | Token budget exceeded during workflow |
| `WorkflowTimeoutError` | `runner/errors` | `workflowId`, `runId`, `elapsedMs` | Wall-clock time exceeded |
| `NodeConfigError` | `runner/errors` | `nodeId`, `nodeType`, `missingField` | Required config missing from a node |
| `CircuitBreakerOpenError` | `runner/errors` | `nodeId` | Node circuit breaker is open |
| `EventLogCorruptionError` | `runner/errors` | `runId` | Missing/corrupt events during recovery |
| `UnsupportedNodeTypeError` | `runner/errors` | `nodeType` | Unknown node type encountered |
| `PermissionDeniedError` | `agent-executor/errors` | — | Agent writes to unauthorized keys |
| `AgentTimeoutError` | `agent-executor/errors` | — | Agent LLM call exceeds timeout |
| `AgentExecutionError` | `agent-executor/errors` | `cause` | Agent LLM call fails (non-timeout) |
| `AgentNotFoundError` | `agent-factory/errors` | — | Agent ID not in registry |
| `AgentLoadError` | `agent-factory/errors` | `cause` | Registry lookup fails (transient) |
| `SupervisorConfigError` | `supervisor-executor/errors` | `supervisorId` | Supervisor missing config |
| `SupervisorRoutingError` | `supervisor-executor/errors` | `chosenNode`, `allowedNodes` | Supervisor routes to invalid node |
| `ArchitectError` | `architect/errors` | — | Graph generation fails after retries |
| `MCPServerNotFoundError` | `mcp/errors` | `serverId` | MCP server registry has no entry for the requested ID |
| `MCPAccessDeniedError` | `mcp/errors` | `serverId`, `agentId` | Agent does not have permission to access the MCP server |
| `PersistenceUnavailableError` | `db/persistence-health` | — | Consecutive persistence failures exceed threshold |

All errors extend `Error` and set `this.name` to their class name, enabling reliable `switch(error.name)` handling across module boundaries.

## Categories

### Config errors — fix graph definition

- `NodeConfigError` — A node is missing required configuration (e.g. `agent_id`, `tool_id`, `approval_config`).
- `SupervisorConfigError` — Supervisor node is missing its `supervisor_config`.
- `UnsupportedNodeTypeError` — The graph references a node type the runner doesn't support.

### Runtime errors — retry or degrade

- `BudgetExceededError` — Token budget exhausted. Non-retryable within the same run.
- `WorkflowTimeoutError` — Execution exceeded wall-clock limit.
- `CircuitBreakerOpenError` — Node failures tripped the breaker. Automatically retries after timeout.
- `AgentTimeoutError` — Individual LLM call timed out. Retryable per `failure_policy`.
- `AgentExecutionError` — LLM call failed (API error, rate limit). Retryable per `failure_policy`.
- `MCPServerNotFoundError` — Registry has no entry for the requested MCP server ID. Non-retryable; fix the agent's tool sources or register the server.
- `MCPAccessDeniedError` — Agent does not have permission to access the MCP server (RBAC denial). Non-retryable; adjust the server's `allowed_agents` or the agent permissions.

### Data integrity errors — halt execution

- `EventLogCorruptionError` — Event log is missing or corrupt. Cannot safely recover.
- `PersistenceUnavailableError` — Database unreachable after consecutive failures. Halts to prevent data loss.

### Agent permission errors — security boundary

- `PermissionDeniedError` — Agent attempted to write to unauthorized memory keys.
- `SupervisorRoutingError` — Supervisor routed to a node outside its `managed_nodes`.

## Retryable vs fatal

| Error | Retryable? | Notes |
|-------|-----------|-------|
| `AgentTimeoutError` | Yes | Retried per `failure_policy.max_retries` |
| `AgentExecutionError` | Yes | With exponential backoff |
| `MCPServerNotFoundError` | No | Fix tool sources or register the server |
| `MCPAccessDeniedError` | No | Security violation — fix agent permissions |
| `CircuitBreakerOpenError` | Auto | Transitions to half-open after timeout |
| `NodeConfigError` | No | Fix the graph definition |
| `UnsupportedNodeTypeError` | No | Fix the graph definition |
| `BudgetExceededError` | No | Budget is exhausted for the run |
| `WorkflowTimeoutError` | No | Max execution time reached |
| `EventLogCorruptionError` | No | Manual intervention required |
| `PersistenceUnavailableError` | No | Halts to prevent data loss |
| `PermissionDeniedError` | No | Security violation — fix agent permissions |
| `SupervisorRoutingError` | No | Supervisor bug — fix agent prompt or managed_nodes |

## Recovery patterns

### Node execution — retry with backoff

`GraphRunner.executeNodeWithRetry()` handles this automatically:
1. Catch error from node executor
2. Check retry count against `failure_policy.max_retries`
3. If retryable: backoff → retry
4. If exhausted or fatal: dispatch `_fail` action

### Circuit breaker — automatic recovery

`CircuitBreakerManager` handles the state machine:

```mermaid
stateDiagram-v2
    direction LR
    CLOSED --> OPEN : failures ≥ threshold
    OPEN --> HALF_OPEN : timeout
    HALF_OPEN --> CLOSED : success
    HALF_OPEN --> OPEN : failure
```

`CircuitBreakerOpenError` is thrown when the breaker is `OPEN` and timeout hasn't elapsed. After timeout, one probe attempt is allowed (`HALF-OPEN` state).

### Persistence degradation — progressive failure

`persistWorkflow()` tracks consecutive failures:
1. 1st failure: log warning, continue
2. 2nd failure: log warning, continue
3. 3rd failure (threshold): throw `PersistenceUnavailableError` → halt workflow

Any success resets the counter to 0.

### Compensation / Saga rollback

For workflows with side effects (e.g. API calls, database writes), nodes can declare compensating actions that undo their work on failure.

Nodes with `requires_compensation: true` push an entry onto the `compensation_stack` in state after successful execution. On failure, if `auto_rollback: true` is set on the `GraphRunner` options, the engine executes compensation entries in LIFO order and transitions the workflow to `cancelled` status.

```typescript
const graph = createGraph({
  name: 'Saga Example',
  nodes: [
    {
      id: 'charge_payment',
      type: 'tool',
      tool_id: 'stripe_charge',
      read_keys: ['order'],
      write_keys: ['payment_result'],
      requires_compensation: true,
    },
    {
      id: 'reserve_inventory',
      type: 'tool',
      tool_id: 'inventory_reserve',
      read_keys: ['order'],
      write_keys: ['reservation'],
      requires_compensation: true,
    },
    // ... more nodes ...
  ],
  edges: [
    { source: 'charge_payment', target: 'reserve_inventory' },
  ],
  start_node: 'charge_payment',
  end_nodes: ['confirm_order'],
});

const runner = new GraphRunner(graph, state, {
  auto_rollback: true, // execute compensation stack on failure
});
```

A node with `requires_compensation: true` pushes a compensation entry onto the `compensation_stack` after successful execution. The host application is responsible for registering the compensating tool calls — the orchestrator does not infer them from the forward action. If `reserve_inventory` fails and `auto_rollback: true` is set, the engine drains the stack in LIFO order (calling each registered compensator) and transitions the workflow to `cancelled`.

When `auto_rollback` is `false` (the default), the compensation stack is preserved in state but not executed — the host application decides how to handle rollback.

### Graceful shutdown

`runner.shutdown()` signals the engine to stop after the current node completes. The workflow remains in `running` status (resumable from the last persisted state) and emits a `workflow:paused` event:

```typescript
const runner = new GraphRunner(graph, state, {
  persistStateFn: async (s) => persistence.saveWorkflowSnapshot(s),
});

// Start the workflow
const resultPromise = runner.run();

// Later, signal graceful stop
runner.shutdown();

// run() resolves after the current node finishes
const pausedState = await resultPromise;
// pausedState.status === 'running' — resumable
```

This is useful for deployments, scaling down, or pausing long-running workflows without losing progress.

### Event log recovery

`GraphRunner.recoverFromEventLog()` replays events:
1. Check for checkpoint (fast path)
2. If no checkpoint: load all events
3. If no events: throw `EventLogCorruptionError`
4. If no `_init` event: throw `EventLogCorruptionError`
5. Verify monotonically increasing sequence IDs across all events
6. Verify the first event is `workflow_started`
7. If any integrity check fails: throw `EventLogCorruptionError`
8. Replay events through reducers to reconstruct state

## Error propagation flow

```mermaid
graph TD
    Throw[Node Executor throws] --> Type{Error Type}
    
    Type --> |Config / Unsupported| Fail[Dispatch _fail]
    Type --> |Permission Denied| Fail
    
    Type --> |Agent Timeout / Execution| Retries{Retries left?}
    Retries -->|Yes| Retry[Backoff & Retry node]
    Retries -->|No| Fail
    
    Type --> |Circuit Breaker Open| Fallback[Skip node & advance to fallback edge]
    
    Type --> |Budget Exceeded| Budget[Dispatch _budget_exceeded]
    
    Type --> |Persistence Unavailable| Worker[Bubbles up to Worker]
    
    Fail --> StatusFailed[status = 'failed']
    Budget --> StatusFailed
    Worker --> JobFailed[Worker marks job as failed]
```

### Dead-lettering (distributed execution)

When using the [WorkflowWorker](/docs/concepts/distributed-execution/), jobs that fail more times than `max_attempts` are moved to a **dead letter** queue. Dead-lettered jobs are not retried automatically — they require manual investigation.

The worker emits a `job:dead_letter` event when this happens:

```typescript
worker.on('job:dead_letter', ({ jobId, runId, error }) => {
  alertOps(`Job ${jobId} (run ${runId}) dead-lettered: ${error}`);
});
```

Monitor queue health via `getQueueDepth()`:

```typescript
const { waiting, active, paused, dead_letter } = await queue.getQueueDepth();
```

## Next steps

- [Workflow State](/docs/concepts/workflow-state/) — the shared state that errors affect
- [Distributed Execution](/docs/concepts/distributed-execution/) — worker crash recovery and dead-lettering
- [Security](/docs/security/) — how write_keys and taint tracking enforce zero trust
- [Tracing](/docs/observability/tracing/) — correlating errors with distributed traces
