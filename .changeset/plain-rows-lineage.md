---
"@cycgraph/orchestrator-postgres": minor
---

Run lineage: `workflow_runs` records where a run came from.

**Requires a migration.** `0020_counterfactual_lineage` adds four columns, a CHECK constraint, and two indexes. It is additive and backfill-free — every existing row is a primary run, which is what the column default gives it.

```bash
npm run migrate --workspace=packages/orchestrator-postgres
```

| Column | Meaning |
| --- | --- |
| `run_kind` | `primary`, `subgraph`, or `counterfactual` |
| `fork_sequence_id` | Where in the parent a counterfactual diverged |
| `fork_mutations` | The changes it applied, so the fork is reproducible from its row |
| `fork_group_id` | Ties one sweep's variants together |

`run_kind` exists because `parent_run_id` alone is ambiguous: subgraph child runs have set it since before forking existed, so the column could no longer say what a row was. Analytics and retention filter on it to keep counterfactual spend out of production numbers unless asked for. `usage_records` references `workflow_runs`, so excluding fork spend is a join rather than a denormalized column.

`DrizzlePersistenceProvider.saveRunLineage()` implements the new optional `PersistenceProvider` method. It is separate from `saveWorkflowRun` because lineage is not derivable from `WorkflowState` — it describes where a run came from, not what it holds — and keeping it out of the state schema keeps it out of event replay.
