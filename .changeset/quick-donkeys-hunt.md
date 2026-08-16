---
"@cycgraph/orchestrator": minor
---

Spend is now attributed to the node that incurred it, and the agent-duration metric has a caller.

`WorkflowState` gained `node_breakdown`, the same shape as `model_breakdown` but keyed by node id. "Which step is expensive" previously could not be answered from a run at all: state carried workflow totals and a per-model split, and per-node spend had to be inferred by diffing consecutive snapshots, which is approximate and breaks entirely under fan-out. Failed attempts are attributed too, so a node that retries shows what the retries cost.

`mcai_agent_duration_ms` was created and never recorded. The agent executor now reports into it, labelled by agent, model, and node.

`REPLAY_VERSION` moves to 3, since `_track_model_usage` writes state it did not before. Replaying a log written under version 2 warns and reconstructs `node_breakdown` as empty, which is what that run actually had.
