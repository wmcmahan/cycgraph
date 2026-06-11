---
title: Deployment Guide
description: Production deployment patterns — concurrency, retention, breakers, and the durability story.
---

This guide is for operators running cycgraph in production. If you're still on `InMemoryPersistence` for local development, skip to the [Persistence concept](/docs/concepts/persistence/) first.

## Minimal production stack

```
                    ┌─────────────────────────┐
                    │  Your application       │
                    │  (HTTP server / worker) │
                    └─────────────┬───────────┘
                                  │
                       new GraphRunner(...)
                                  │
              ┌───────────────────┼────────────────────┐
              ▼                   ▼                    ▼
   ┌────────────────────┐ ┌────────────────┐ ┌─────────────────────┐
   │  Postgres 16       │ │ MCP servers    │ │ OTel collector      │
   │  + pgvector        │ │ (sandboxed)    │ │ (Jaeger / Tempo /…) │
   └────────────────────┘ └────────────────┘ └─────────────────────┘
```

Required:

- **Postgres 16** with the `vector` extension installed (`init.sql` in `@cycgraph/orchestrator-postgres` handles this)
- **Migrations applied** — run `npm run db:migrate` (or `drizzle-kit migrate`) before first boot and on every upgrade. The durable job queue (`workflow_jobs`) and the run `claim_epoch` fencing column ship in migration `0014`.
- **MCP servers** running in isolated containers — never on the host

Optional but recommended:

- **OpenTelemetry collector** — agents emit spans for every node and tool call; wire to Jaeger, Tempo, or Honeycomb via `OTEL_EXPORTER_OTLP_ENDPOINT`
- **Prometheus scraper** for `MCPConnectionManager.getToolCircuitMetrics()` and your own custom metrics

## Wiring the postgres adapter

The `GraphRunner` consumes persistence through injected callbacks (`persistStateFn`, `eventLog`), not provider objects directly — so you adapt the Drizzle providers into the runner's options. In production you usually drive runs through a `WorkflowWorker` rather than constructing `GraphRunner` by hand:

```typescript
import { WorkflowWorker } from '@cycgraph/orchestrator';
import {
  DrizzleWorkflowQueue,
  DrizzlePersistenceProvider,
  DrizzleEventLogWriter,
  createFencedRunnerOptions,
} from '@cycgraph/orchestrator-postgres';

const worker = new WorkflowWorker({
  queue: new DrizzleWorkflowQueue(),
  persistence: new DrizzlePersistenceProvider(),
  eventLog: new DrizzleEventLogWriter({ retain_checkpoints: 3 }),
  // Per-job fenced writers carry the job's claim epoch (see below).
  runnerOptionsFactory: (job) => ({
    ...createFencedRunnerOptions(job),
    toolResolver: new MCPConnectionManager(mcpRegistry),
  }),
});

await worker.start();
```

To drive a single run directly instead, adapt the provider into a `persistStateFn`:

```typescript
const persistence = new DrizzlePersistenceProvider();
const runner = new GraphRunner(graph, state, {
  persistStateFn: (s) => persistence.saveWorkflowSnapshot(s),
  eventLog: new DrizzleEventLogWriter({ retain_checkpoints: 3 }),
  toolResolver: new MCPConnectionManager(mcpRegistry),
});
```

Set `DATABASE_URL` in the environment. The pool is lazily initialized with 5 retries / exponential backoff; if the DB is unreachable at startup, the first save will throw a descriptive error.

## Concurrency model

| Layer | Concurrency | Tuning |
| --- | --- | --- |
| **GraphRunner** | Single-threaded per-run | Run multiple `GraphRunner` instances concurrently for parallel workflows |
| **Map / voting nodes** | Workers run in parallel inside one run | `map_reduce_config.max_concurrency` per node (default: unlimited) |
| **MCP tool calls** | One per tool per agent step | Concurrent calls to *different* tools within the same step are sequential by AI SDK design |
| **Postgres pool** | 20 connections | `DB_POOL_MAX` env var |

### Version-increment retry

Concurrent saves to the same `run_id` race on the `MAX(version)+1` increment. The persistence adapter **automatically retries** unique-violation errors with full-jitter exponential backoff (default: 5 retries, 10–500ms delays). You do not need to wrap saves yourself. This handles benign in-process races (e.g. a delta write and a snapshot landing together).

### Run fencing (multi-worker safety)

Version-increment retry resolves *who writes which version*, but it does not stop **two workers executing the same run** from interleaving state. That's the job of fencing.

Every `DrizzleWorkflowQueue.dequeue()` bumps a `claim_epoch` on the run row. `createFencedRunnerOptions(job)` builds persistence and event-log writers that carry the job's epoch and verify it inside each write transaction; a write from a worker whose claim was reclaimed (missed heartbeats during a GC pause or partition) is rejected with `StaleClaimError`, and the runner aborts immediately rather than clobbering the new claimant.

Always wire `runnerOptionsFactory: (job) => createFencedRunnerOptions(job)` on the worker for multi-process deployments. Without it, a paused-but-alive worker can resume after its job was reclaimed and corrupt the run. The event log independently rejects duplicate `(run_id, sequence_id)` appends with `EventSequenceConflictError`, which the runner also treats as fatal — a second line of defense against split-brain.

## Retention policy

### Workflow runs and states

`RetentionService.archiveCompletedWorkflows()` soft-deletes runs older than 24h that have terminal status (`completed` / `failed` / `cancelled` / `timeout`). `deleteWarmData()` hard-deletes archived state rows older than 30 days. Wire these into a cron:

```typescript
import { DrizzleRetentionService } from '@cycgraph/orchestrator-postgres';
const retention = new DrizzleRetentionService();

// Cron: every hour
await retention.archiveCompletedWorkflows();

// Cron: nightly
await retention.deleteWarmData();
```

### Event log

The event log table is the largest. Two complementary mechanisms keep it bounded:

1. **Per-run compaction**: `eventLog.compact(run_id, beforeSequenceId)` deletes events up to the given sequence. The runner calls this internally after writing a checkpoint.
2. **Checkpoint pruning**: `DrizzleEventLogWriter` keeps only the latest `retain_checkpoints` (default: 3) per run. Older checkpoints are dropped inside the same transaction as each new write — no manual cleanup needed.

If you change `retain_checkpoints`, the new value applies to writes only. Existing checkpoint rows beyond the new retention are not retroactively pruned — run a one-shot cleanup query if you reduce retention.

## Circuit breakers

cycgraph has two independent breaker layers:

| Layer | Granularity | Configured at |
| --- | --- | --- |
| **Node-level** | Per graph node | `node.failure_policy.circuit_breaker` |
| **Tool-level** | Per `(serverId, toolName)` | `MCPConnectionManagerOptions.tool_circuit_breaker` |

The tool layer opens on a single misbehaving tool while sibling tools on the same MCP server remain usable. The node layer opens on a misbehaving *node* (which may have nothing to do with tools — could be a router, a reducer, or a stuck supervisor).

Inspect breaker state in production:

```typescript
const metrics = mcpManager.getToolCircuitMetrics();
// [{ server_id, tool_name, status, consecutive_failures, total_calls, ... }]
```

Wire this into your `/metrics` endpoint and alert on `status === 'open'`.

## Observability

### Stream events worth alerting on

Subscribe to the `runner.stream()` generator and forward to your observability stack:

| Event | Severity | Why |
| --- | --- | --- |
| `workflow:failed` | Page | Run terminated with `status: 'failed'` |
| `workflow:timeout` | Page | Hit `max_execution_time_ms` |
| `budget:threshold_reached` | Warn | Approaching `max_token_budget` / `budget_usd` |
| `memory:dropped` | Warn | Oversized or non-serializable memory update — investigate the producing agent |
| `node:failed` (attempt = max_retries) | Warn | A node has exhausted its retries |

### OpenTelemetry spans

Set `OTEL_EXPORTER_OTLP_ENDPOINT` to enable. Span hierarchy:

```
workflow.run
├── node.execute.supervisor
│   └── supervisor.route
├── node.execute.agent
│   └── agent.execute
├── node.execute.evolution
└── node.execute.tool
```

Each tool call gets its own span via the MCP layer's `wrapToolWithTaint` — search by `mcp_tool` attribute.

## Security checklist before going live

See [SECURITY.md](https://github.com/wmcmahan/cycgraph/blob/main/SECURITY.md) for the full list. Quick version:

- [ ] MCP servers run in isolated containers — no host filesystem mounts
- [ ] Every workflow has both `max_token_budget` and `budget_usd` set
- [ ] Every workflow has both `max_execution_time_ms` and `max_iterations` set
- [ ] Agent `read_keys` and `write_keys` are narrow — avoid `'*'`
- [ ] The eval harness runs in CI before publishing agent or graph changes
- [ ] You have an alert on `workflow:failed` and `budget:threshold_reached` events
- [ ] Retention crons are scheduled

## Common production issues

See [Troubleshooting](/docs/getting-started/troubleshooting/) for first-run errors and [Error Handling](/docs/concepts/error-handling/) for the full error catalogue. The deployment-specific ones:

| Symptom | Cause | Fix |
| --- | --- | --- |
| `ToolCircuitBreakerOpenError` for one tool only | That tool is consistently failing | Inspect the MCP server logs. Once it recovers, the breaker auto-closes after a probe. |
| `EmbeddingDimensionMismatchError` after deploy | Embedding provider was swapped without re-embedding | Rebuild stored vectors with the new dimension, or migrate via a batch script. |
| Postgres pool exhausted | Long-running transactions | Investigate slow queries. Increase `DB_POOL_MAX` only after confirming the underlying cause. |
| Event log table grows unbounded | Retention crons not wired | Schedule `archiveCompletedWorkflows()` + `deleteWarmData()`. Run a one-shot prune if backlogged. |
| Workflow stuck in `waiting` | Human-in-the-loop never received approval | Check `state.waiting_timeout_at` — defaults to 24h. Send a `resume_from_human` action. |
| `StaleClaimError` / `job:claim_lost` events | A worker's job was reclaimed (missed heartbeats) and another worker took over | Expected under partitions/GC pauses — fencing working as designed. If frequent, raise `heartbeatIntervalMs` headroom or investigate worker pauses. |
| `EventSequenceConflictError` | Two workers appended to the same run | Indicates a fencing gap — confirm `runnerOptionsFactory: createFencedRunnerOptions` is wired and the queue is `DrizzleWorkflowQueue`. |
| `EventLogCorruptionError` on recovery | A sequence gap (lost append) in the event log | The worker auto-falls-back to the latest snapshot when it's ahead; if not, inspect for lost DB writes. |
