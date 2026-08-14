# Postgres Persistence

Durable state, event sourcing, and usage tracking against a real database via
`@cycgraph/orchestrator-postgres`. Everything the in-memory examples keep in
process survives a restart here.

The feature on show is idempotent agent registration: agents live in the
Postgres-backed `DrizzleAgentRegistry`, so nodes reference them by stored id
and re-running does not duplicate them.

## Graph

```
research → research_notes
   └── write → article
```

Deliberately plain. The interest is in what happens around the graph, not in
its topology.

## Lifecycle & State

| Table | Written by | Contents |
| --- | --- | --- |
| `workflow_states` | `DrizzlePersistenceProvider` | versioned state snapshots |
| `workflow_events` | `DrizzleEventLogWriter` | append-only action log for replay |
| `usage_records` | `DrizzleUsageRecorder` | per-run tokens and cost |
| `agents` | `DrizzleAgentRegistry` | agent configs, registered once |

## Run

Bring up the database and apply migrations first:

```bash
docker-compose up -d
npm run migrate --workspace=packages/orchestrator-postgres
```

Then:

```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5433/mcai \
  ANTHROPIC_API_KEY=sk-ant-... \
  npx tsx examples/postgres-persistence/postgres-persistence.ts
```

Podman works as a drop-in for Docker: `podman compose up -d postgres`.

## Expected Output

```
Registered agents: researcher=<uuid>, writer=<uuid>
Status: completed
Snapshots persisted: 6
Events logged: 14
Tokens: 2431   Cost: $0.0091
```

Run it twice. The agent ids stay the same, and a second set of rows appears
under a new `run_id`.

## Notes

**Why an explicit `GraphRunner`.** The example inspects the final
`WorkflowState` and verifies what landed in the database, neither of which the
one-call `run()` helper exposes.

**Event log versus snapshots.** Snapshots let a run resume from where it
stopped. The event log lets it be replayed deterministically from the
beginning through the same reducers, with no LLM calls, because the stored
actions already carry the agent outputs. `GraphRunner.recover()` uses the
latter.

**This example is excluded from `npm run smoke`**, which does not assume a
database.
