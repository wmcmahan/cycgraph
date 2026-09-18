<div align="center">

# @cycgraph/orchestrator-postgres

**Postgres + pgvector adapter for [`@cycgraph/orchestrator`](https://www.npmjs.com/package/@cycgraph/orchestrator)**

[![npm](https://img.shields.io/npm/v/@cycgraph/orchestrator-postgres?color=cb3837)](https://www.npmjs.com/package/@cycgraph/orchestrator-postgres)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://github.com/wmcmahan/cycgraph/blob/main/LICENSE)

</div>


## Install

```bash
npm install @cycgraph/orchestrator-postgres
```

## Setup

Set `DATABASE_URL` to a Postgres 16 database with the pgvector extension available. The package ships its migration files in `drizzle/`; apply them with drizzle-orm's migrator:

```typescript
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
await migrate(drizzle(pool), {
  migrationsFolder: 'node_modules/@cycgraph/orchestrator-postgres/drizzle',
});
```

Working in the cycgraph monorepo instead: `docker-compose up -d` starts Postgres on port 5433, then `npm run migrate --workspace=packages/orchestrator-postgres` applies the migrations.

### Connection roles

Three connection strings map to three roles. A single-tenant or development deployment sets only `DATABASE_URL`; the other two fall back to it.

| Variable | Role | Used by | When unset |
|----------|------|---------|------------|
| `DATABASE_URL` | Table owner | Migrations and all unscoped adapter reads/writes (`getDb()`) | Required — `getDb()` throws |
| `APP_DATABASE_URL` | Non-owner login with `cycgraph_app` membership, subject to row-level security | `withTenant` / tenant-scoped work (`getAppDb()`) | Falls back to the owner connection; RLS does not engage, and the adapters' `tenant_id` filters do the isolating |
| `PLATFORM_DATABASE_URL` | `cycgraph_admin` (`BYPASSRLS`, created by migration `0019`) | `withPlatform` / cross-tenant sweeps such as queue dequeue, claim reclaim, and retention GC (`getPlatformDb()`) | Falls back to the owner connection — correct for a superuser owner, **but see the production requirement below** |

> **Production requirement.** Migration `0019` applies `FORCE` row-level security, which subjects even a non-superuser table owner to tenant policies. A production deployment with `FORCE` RLS and a non-superuser owner **must** set `PLATFORM_DATABASE_URL`; otherwise the cross-tenant sweeps run on an RLS-subject connection and are silently filtered to zero rows — the queue stops dispatching and retention stops collecting, with no error.

See [MULTI_TENANCY.md](https://github.com/wmcmahan/cycgraph/blob/main/packages/orchestrator-postgres/src/MULTI_TENANCY.md) for the role grants and the migration sequence that establishes them.

## Why

- **Durable execution** — workflows survive process restarts via event-sourced replay
- **Production event log** — checkpoints, compaction, and conflict-rejecting appends
- **Durable job queue** — atomic claims and run fencing across multiple processes
- **Shared agent registry** — agent configs shared across multiple worker processes
- **Persistent knowledge graph** — queryable graph with pgvector HNSW similarity search

## Concepts

Adapters take their connection from the lazily-initialized owner pool behind `getDb()`. Set `DATABASE_URL` in the environment and the pool is created on first use (call `getDb()` up front to fail fast). Constructors take no `db` argument; each accepts an optional options object for concerns like tenant scoping, run fencing, or checkpoint retention.

Two further pools exist for the isolation planes and are opened only when their connection strings are set: `getAppDb()` (`APP_DATABASE_URL`, the RLS-subject role used by `withTenant`) and `getPlatformDb()` (`PLATFORM_DATABASE_URL`, the `BYPASSRLS` role used by `withPlatform`). Each falls back to the owner pool when its variable is unset, so a deployment that sets only `DATABASE_URL` does run on one pool. `closeDb()` ends all three. See [Connection roles](#connection-roles) for the production requirement on `PLATFORM_DATABASE_URL`.

```typescript
import {
  getDb,
  closeDb
} from '@cycgraph/orchestrator-postgres';

await getDb();
await closeDb();
```

### DrizzlePersistenceProvider

Atomic state snapshots, run records, and versioned history.

```typescript
const persistence = new DrizzlePersistenceProvider();

const runner = new GraphRunner(graph, state, {
  eventLog,
  persistState: async (s) => {
    await persistence.saveWorkflowSnapshot(s);
  },
});
```

### DrizzleEventLogWriter

Append-only event log with auto-compaction.

```typescript
const eventLog = new DrizzleEventLogWriter({
  retain_checkpoints: 3,
});

const runner = new GraphRunner(graph, state, {
  eventLog,
  persistState: async (s) => {
    await persistence.saveWorkflowSnapshot(s);
  },
});
```

### DrizzleWorkflowQueue

Durable job queue with atomic claims and per-claim fencing epochs.

```typescript
import { DrizzleWorkflowQueue } from '@cycgraph/orchestrator-postgres';

const queue = new DrizzleWorkflowQueue();

const job = await queue.dequeue(workerId);
```

The visibility timeout is set per job at `enqueue()` time via `visibility_timeout_ms` (default 300 000).

### DrizzleAgentRegistry

Multi-process agent config store.

```typescript
import { DrizzleAgentRegistry } from '@cycgraph/orchestrator-postgres';

const agentRegistry = new DrizzleAgentRegistry();
```

### DrizzleMCPServerRegistry

Trusted store for MCP server transport configs, re-validated on every read/write.

```typescript
import { DrizzleMCPServerRegistry } from '@cycgraph/orchestrator-postgres';

const mcpServers = new DrizzleMCPServerRegistry();
```

### DrizzleUsageRecorder

Per-run token + cost tracking.

```typescript
import { DrizzleUsageRecorder } from '@cycgraph/orchestrator-postgres';

const usageRecorder = new DrizzleUsageRecorder();

const startedAt = Date.now();
const finalState = await runner.run();
await usageRecorder.saveUsageRecord({
  run_id: finalState.run_id,
  graph_id: graph.id,
  input_tokens: finalState.total_input_tokens,
  output_tokens: finalState.total_output_tokens,
  cost_usd: finalState.total_cost_usd,
  duration_ms: Date.now() - startedAt,
});
```

### DrizzleRetentionService

Tiered data-lifecycle GC (hot/warm/cold) with transactional safety. Sweeps are bulk and cutoff-based, not per-run — wire them into cron jobs.

```typescript
import { DrizzleRetentionService } from '@cycgraph/orchestrator-postgres';

const retentionService = new DrizzleRetentionService();

await retentionService.archiveCompletedWorkflows();

await retentionService.deleteWarmData();

const stats = await retentionService.getStorageStats();
```

### DrizzleMemoryStore

Entities, relationships, episodes, facts, and themes with temporal validity.

```typescript
import { DrizzleMemoryStore } from '@cycgraph/orchestrator-postgres';

const memoryStore = new DrizzleMemoryStore();
```

### DrizzleMemoryIndex

pgvector HNSW similarity search over facts, themes, and entities.

```typescript
import { DrizzleMemoryIndex } from '@cycgraph/orchestrator-postgres';

const memoryIndex = new DrizzleMemoryIndex();
```
### DrizzleOutcomeLedger

Provides run-outcome evidence that survives restarts, so the retention gate can accumulate the trials it needs to resolve real effects plus a gate-decision audit log for observability.

```typescript
import {
  DrizzleOutcomeLedger
} from '@cycgraph/orchestrator-postgres';
import { evaluateRetention } from '@cycgraph/memory';
import { getInjectedFactIds } from '@cycgraph/orchestrator';

const ledger = new DrizzleOutcomeLedger();

await ledger.recordOutcome({
  run_id,
  score,
  fact_ids: getInjectedFactIds(finalState),
});

const report = await evaluateRetention(store, ledger, policy);
await ledger.recordGateDecisions(report);

await ledger.listGateDecisions({ decision: 'evicted', limit: 20 });
await ledger.getLessonHistory(factId);
await ledger.getFitnessTrend({ limit: 100 });
```

### Run fencing

`createFencedRunnerOptions` wires the fencing epoch from a claimed job into per-job fenced persistence and event-log writers. A worker whose job is reclaimed (missed heartbeats during a GC pause or partition) gets `StaleClaimError` on its next write and aborts, instead of silently interleaving state with the new claimant. This is the required wiring when multiple workers share one queue.

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
  eventLog: new DrizzleEventLogWriter(),
  // Per-job fenced writers — factory results override the worker defaults.
  runnerOptionsFactory: (job) => createFencedRunnerOptions(job),
});
```

### Multi-tenancy

The schema carries a `tenants` table with row-level security, and every adapter accepts a tenant option that stamps writes and filters reads. `withTenant` / `withPlatform` are the transaction-level isolation primitives; `createTenantScope` / `createPlatformScope` build per-request scopes for a hosted control plane, with `hashApiKey` / `generateApiKey` and a pluggable `TenantResolver` for credential resolution. Single-tenant deployments can ignore all of it — with no tenant option set, adapters operate unscoped. See [MULTI_TENANCY.md](https://github.com/wmcmahan/cycgraph/blob/main/packages/orchestrator-postgres/src/MULTI_TENANCY.md) for the full model.

## Workflow tables

| Table | Purpose |
|-------|---------|
| `tenants` | Tenant registry for row-level-security isolation |
| `graphs` | Reusable graph definitions |
| `workflows` | User workflow instances |
| `workflow_runs` | Execution run metadata, claim-epoch fencing, and fork lineage |
| `workflow_states` | Versioned state snapshots |
| `workflow_events` | Append-only event log with unique constraint |
| `workflow_checkpoints` | State snapshots for event log compaction |
| `workflow_jobs` | Durable job queue for claims, visibility timeouts, and run fencing |
| `agents` | Agent configuration registry |
| `usage_records` | Per-run token and cost tracking |
| `mcp_servers` | Trusted MCP server registry with access-control rules |
| `documents` | RAG source documents |
| `embeddings` | Vector embeddings for semantic search |

### Memory tables

| Table | Purpose |
|-------|---------|
| `memory_entities` | Knowledge-graph nodes |
| `memory_relationships` | Directed temporal edges |
| `memory_episodes` | Message groups |
| `memory_facts` | Atomic semantic facts |
| `memory_themes` | Fact clusters |
| `memory_entity_facts` | Join table for entity ↔ fact lookups |

### Learning tables

| Table | Purpose |
|-------|---------|
| `run_outcomes` | Per-run outcome scores for the eval gate |
| `run_outcome_facts` | Which injected facts each outcome attributes to |
| `gate_decisions` | Append-only audit log of retention-gate passes |

## Contributing

Issues and PRs welcome. See [CONTRIBUTING.md](https://github.com/wmcmahan/cycgraph/blob/main/CONTRIBUTING.md) for development setup, coding standards, and the architecture decisions worth knowing before opening a PR. Security disclosures go through [SECURITY.md](https://github.com/wmcmahan/cycgraph/blob/main/SECURITY.md).

## License

[Apache 2.0](https://github.com/wmcmahan/cycgraph/blob/main/LICENSE).