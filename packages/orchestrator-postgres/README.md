<div align="center">

# @cycgraph/orchestrator-postgres

**Postgres + pgvector adapter for cycgraph. Durable workflow state, event sourcing, agent registry, and memory backend in one package.**

[![npm](https://img.shields.io/npm/v/@cycgraph/orchestrator-postgres?color=cb3837)](https://www.npmjs.com/package/@cycgraph/orchestrator-postgres)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](../../LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D24-339933?logo=node.js&logoColor=white)](https://nodejs.org)

[📚 Documentation](https://flattop.io/operations/deployment/) &nbsp;·&nbsp; [📖 Schema reference](./src/schema.ts)

</div>

---

Drop-in Postgres backend for [`@cycgraph/orchestrator`](https://www.npmjs.com/package/@cycgraph/orchestrator). Every interface (`PersistenceProvider`, `EventLogWriter`, `AgentRegistry`, `UsageRecorder`, `RetentionService`, plus the `@cycgraph/memory` `MemoryStore` / `MemoryIndex`) has a Drizzle ORM implementation that swaps in for the in-memory defaults — one import change.

Use this package when:
- You need workflows to **survive process restarts** (durable execution via event-sourced replay).
- You want a **production-grade event log** with checkpoints, compaction, and conflict-rejecting appends.
- You need a **durable job queue** with atomic claims and run fencing to run workflows safely across multiple processes.
- You need to **share an agent registry** across multiple worker processes.
- You're using `@cycgraph/memory` and want a **persistent, queryable knowledge graph** with pgvector HNSW similarity search.

## Install

```bash
npm install @cycgraph/orchestrator-postgres
```

**Peer dependencies:** `@cycgraph/orchestrator`, `drizzle-orm`, `postgres`.

## Setup

```bash
# Start Postgres (docker-compose.yml provided at the repo root)
docker compose up -d

# Set connection string
export DATABASE_URL="postgresql://postgres:postgres@localhost:5433/mcai"

# Run migrations (creates all tables — workflow + memory)
npm run db:migrate
```

The bundled `docker-compose.yml` ships `postgres:16` with `pgvector` enabled and runs on port `5433` (so it won't clash with a local Postgres on 5432).

## Usage

```typescript
import {
  DrizzlePersistenceProvider,
  DrizzleEventLogWriter,
  DrizzleAgentRegistry,
  DrizzleUsageRecorder,
} from '@cycgraph/orchestrator-postgres';
import { GraphRunner } from '@cycgraph/orchestrator';

const persistence = new DrizzlePersistenceProvider();
const eventLog = new DrizzleEventLogWriter();
const usageRecorder = new DrizzleUsageRecorder();
const agentRegistry = new DrizzleAgentRegistry();

const WRITER_ID = await agentRegistry.register({
  name: 'Writer',
  model: 'claude-sonnet-4-20250514',
  provider: 'anthropic',
  system_prompt: 'You are a writer.',
  tools: [],
  permissions: { read_keys: ['*'], write_keys: ['draft'] },
});

const runner = new GraphRunner(graph, state, {
  persistStateFn: async (s) => { await persistence.saveWorkflowSnapshot(s); },
  eventLog,
});

const finalState = await runner.run();
await usageRecorder.record({ run_id: finalState.run_id, tokens: finalState.total_tokens_used, cost_usd: finalState.total_cost_usd });
```

If a worker process crashes mid-run, the next `GraphRunner` instance loaded with the same `run_id` will resume from the last persisted state and replay events from the event log — no work lost.

## What ships in this package

### Workflow durability

| Class | Implements | Purpose |
|-------|-----------|---------|
| `DrizzlePersistenceProvider` | `PersistenceProvider` | Atomic state snapshots, run records, versioned history (`workflow_runs`, `workflow_states`); optional run fencing |
| `DrizzleEventLogWriter` | `EventLogWriter` | Append-only event log + auto-compaction (`workflow_events`, `workflow_checkpoints`); rejects duplicate `(run_id, sequence_id)` appends; optional run fencing |
| `DrizzleWorkflowQueue` | `WorkflowQueue` | Durable job queue with `FOR UPDATE SKIP LOCKED` atomic claims and per-claim fencing epochs (`workflow_jobs`) |
| `DrizzleAgentRegistry` | `AgentRegistry` | Multi-process agent config store (`agents`) |
| `DrizzleUsageRecorder` | `UsageRecorder` | Per-run token + cost tracking (`usage_records`) |
| `DrizzleRetentionService` | `RetentionService` | Tiered archival (hot/warm/cold) with transactional safety |

### Memory backend (for `@cycgraph/memory`)

| Class | Implements | Purpose |
|-------|-----------|---------|
| `DrizzleMemoryStore` | `MemoryStore` | Entities, relationships, episodes, facts, themes — CRUD with temporal validity |
| `DrizzleMemoryIndex` | `MemoryIndex` | pgvector HNSW similarity search over facts, themes, entities |

```typescript
import { DrizzleMemoryStore, DrizzleMemoryIndex } from '@cycgraph/orchestrator-postgres';
import { retrieveMemory } from '@cycgraph/memory';

const store = new DrizzleMemoryStore();
const index = new DrizzleMemoryIndex();

// Same `retrieveMemory()` API as the in-memory backend
const result = await retrieveMemory(store, index, {
  tags: ['lesson:research-v1'],
  limit: 20, max_hops: 0, min_similarity: 0, include_invalidated: false,
});
```

## Schema overview

Defined in [`src/schema.ts`](./src/schema.ts) and managed via Drizzle migrations in [`drizzle/`](./drizzle/).

### Workflow tables

| Table | Purpose |
|-------|---------|
| `graphs` | Reusable graph definitions |
| `workflow_runs` | Execution run metadata |
| `workflow_states` | Versioned state snapshots (ordered by `version`, not timestamp) |
| `workflow_events` | Append-only event log with `(run_id, sequence_id)` unique constraint |
| `workflow_checkpoints` | State snapshots for event log compaction |
| `workflow_jobs` | Durable job queue (`DrizzleWorkflowQueue`) — `SKIP LOCKED` claims, visibility timeouts |
| `agents` | Agent configuration registry (includes `provider_options` JSONB) |
| `usage_records` | Per-run token and cost tracking |
| `mcp_servers` | Trusted MCP server registry with access-control rules |

`workflow_runs` carries a `claim_epoch` column — the [run fencing](https://flattop.io/concepts/distributed-execution/#run-fencing) token bumped on every job claim.

### Memory tables

| Table | Purpose |
|-------|---------|
| `memory_entities` | Knowledge-graph nodes |
| `memory_relationships` | Directed temporal edges (`source_id` → `target_id`, with `valid_from` / `valid_until`) |
| `memory_episodes` | Message groups |
| `memory_facts` | Atomic semantic facts (with `tags` JSONB column for tag-based retrieval) |
| `memory_themes` | Fact clusters |
| `memory_entity_facts` | Join table for entity ↔ fact lookups |

All embedding columns use pgvector HNSW indexes with cosine distance.

## Migrations

```bash
# Generate a new migration after editing schema.ts
npx drizzle-kit generate --config=packages/orchestrator-postgres/drizzle.config.ts

# Apply pending migrations
npm run db:migrate

# Push schema directly (dev only — bypasses the migration history)
npx drizzle-kit push --config=packages/orchestrator-postgres/drizzle.config.ts
```

### Embedding dimensions

Default is **1536** (OpenAI `text-embedding-ada-002`, `text-embedding-3-small`). To use a different dimension, edit `EMBEDDING_DIMENSIONS` in `src/schema.ts` and generate a new migration.

```typescript
import { EMBEDDING_DIMENSIONS } from '@cycgraph/orchestrator-postgres';
// Default: 1536
```

## Operational notes

- **Atomic snapshots** — `DrizzlePersistenceProvider.saveWorkflowSnapshot()` wraps both run and state writes in a single transaction. No torn writes if either fails.
- **Idempotent event appends** — duplicate `(run_id, sequence_id)` pairs are silently ignored via `ON CONFLICT DO NOTHING`. Retries after network timeouts are safe.
- **Version-ordered state loads** — `loadLatestWorkflowState()` sorts by `version`, not `created_at`. Handles sub-millisecond saves correctly.
- **Transactional archival** — `archiveCompletedWorkflows()` wraps its two-phase update (run status + state status) in a transaction. Either both succeed or both roll back.
- **Event log writes propagate errors** — failed appends (other than dedup conflicts) are not silently swallowed. The `GraphRunner` sees the error and increments its failure counter so observability dashboards can alert.

## Common errors

| Symptom | Cause | Fix |
|---|---|---|
| `password authentication failed` | Connection string doesn't match the docker-compose defaults | The bundled `docker-compose.yml` uses `postgres:postgres@localhost:5433/mcai` — adjust accordingly if you customised it |
| `database "mcai" does not exist` | Migrations not yet run | `npm run db:migrate` |
| `extension "vector" is not available` | Using stock Postgres without pgvector | Use the bundled `docker-compose.yml` (image includes pgvector) or install the extension yourself |
| `Could not find a relation "memory_facts"` | Old migration history before the memory schema landed | Regenerate from scratch: drop the DB, recreate, run all migrations |
| Slow vector queries | Missing HNSW indexes | Confirm migrations applied through `0006_minor_pixie` — that's when the `idx_*_embedding` indexes land |

## Testing

Tests require a running Postgres instance. They are skipped automatically when `DATABASE_URL` is not set.

```bash
docker compose up -d
DATABASE_URL="postgresql://postgres:postgres@localhost:5433/mcai" \
  npm run test --workspace=packages/orchestrator-postgres
```

## Contributing

Issues and PRs welcome on [GitHub](https://github.com/wmcmahan/cycgraph). See [CONTRIBUTING.md](https://github.com/wmcmahan/cycgraph/blob/main/CONTRIBUTING.md).

## License

[Apache 2.0](https://github.com/wmcmahan/cycgraph/blob/main/LICENSE).