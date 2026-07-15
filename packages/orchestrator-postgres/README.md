<div align="center">

# @cycgraph/orchestrator-postgres

**Postgres + pgvector adapter for [`@cycgraph/orchestrator`](https://www.npmjs.com/package/@cycgraph/orchestrator)**

[![npm](https://img.shields.io/npm/v/@cycgraph/orchestrator-postgres?color=cb3837)](https://www.npmjs.com/package/@cycgraph/orchestrator-postgres)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](../../LICENSE)

</div>


## Install

```bash
npm install @cycgraph/orchestrator-postgres
```

## Why

- **Durable execution** — workflows survive process restarts via event-sourced replay
- **Production event log** — checkpoints, compaction, and conflict-rejecting appends
- **Durable job queue** — atomic claims and run fencing across multiple processes
- **Shared agent registry** — agent configs shared across multiple worker processes
- **Persistent knowledge graph** — queryable graph with pgvector HNSW similarity search

## Concepts

All adapters share a single lazily-initialized connection pool from `getDb()`. Set `DATABASE_URL` in the environment and the pool is created on first use (call `getDb()` up front to fail fast). Constructors take no `db` argument.

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
  persistStateFn: async (s) => {
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
  persistStateFn: async (s) => {
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

## Workflow tables

| Table | Purpose |
|-------|---------|
| `graphs` | Reusable graph definitions |
| `workflow_runs` | Execution run metadata |
| `workflow_states` | Versioned state snapshots |
| `workflow_events` | Append-only event log with unique constraint |
| `workflow_checkpoints` | State snapshots for event log compaction |
| `workflow_jobs` | Durable job queue for claims, visibility timeouts, and run fencing |
| `agents` | Agent configuration registry |
| `usage_records` | Per-run token and cost tracking |
| `mcp_servers` | Trusted MCP server registry with access-control rules |

### Memory tables

| Table | Purpose |
|-------|---------|
| `memory_entities` | Knowledge-graph nodes |
| `memory_relationships` | Directed temporal edges |
| `memory_episodes` | Message groups |
| `memory_facts` | Atomic semantic facts |
| `memory_themes` | Fact clusters |
| `memory_entity_facts` | Join table for entity ↔ fact lookups |

## Contributing

Issues and PRs welcome. See [CONTRIBUTING.md](https://github.com/wmcmahan/cycgraph/blob/main/CONTRIBUTING.md) for development setup, coding standards, and the architecture decisions worth knowing before opening a PR. Security disclosures go through [SECURITY.md](https://github.com/wmcmahan/cycgraph/blob/main/SECURITY.md).

## License

[Apache 2.0](https://github.com/wmcmahan/cycgraph/blob/main/LICENSE).