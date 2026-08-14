# Workflow Observer

A workflow that reads another workflow's event log and produces a triage
report, without touching the workflow it observes. The engine is dogfooding
itself: the observer is an ordinary graph whose input happens to be run data.

## Graph

Two graphs run in sequence.

```
target:                                observer:
  supervisor                             observer_supervisor
    ├── researcher → research_notes        ├── token_analyst    → token_analysis
    └── writer     → summary               ├── stall_detector   → stall_analysis
                                           ├── error_classifier → error_analysis
                                           └── report_writer    → triage_report
```

The target runs on the durable queue through a `WorkflowWorker`. The observer
reads its events afterwards.

## Lifecycle & State

| Key | Written by | Notes |
| --- | --- | --- |
| `target_events`, `target_snapshot` | middleware | the target's log and state, injected before each observer agent runs |
| `token_analysis` | token_analyst | where the budget went |
| `stall_analysis` | stall_detector | nodes that looped or made no progress |
| `error_analysis` | error_classifier | failures grouped by cause |
| `triage_report` | report_writer | the synthesis |

The observer never writes to the target's state. It reads a copy of the
target's events, injected as ordinary memory.

## Run

```bash
ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/workflow-observer/run.ts
```

## Expected Output

```
━━━ Target workflow ━━━
Status: completed   Nodes: supervisor → researcher → supervisor → writer → supervisor

━━━ Observer ━━━
Triage report:
  Token burn concentrated in the supervisor (3 routing turns, 61% of spend)
  No stalls detected
  No errors
```

## Notes

**Read-only by construction.** The observer gets the target's events through
middleware injection rather than a shared handle, so there is no path by which
it could mutate what it is analyzing.

**Needs a capable model.** Two full supervisor workflows have to complete
inside the run's time cap, and the analyst agents have to reason over a raw
event log. `npm run smoke` lists this as capability-dependent and does not gate
on it: on a small local model it times out, which says nothing about the
engine.

**Why an explicit `GraphRunner` and `WorkflowWorker`.** The observer needs the
shared event log and middleware, and the target runs on the durable queue.
Neither is reachable through the one-call `run()` helper.
