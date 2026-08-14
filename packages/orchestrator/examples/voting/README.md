# Voting

Three specialist agents review the same technical proposal independently, and
a strategy aggregates their verdicts. Voters run in parallel; the node handles
fan-out, quorum, and aggregation internally.

## Graph

```
review-vote  (voting node)
  ├── security voter      ┐
  ├── performance voter   ├─ parallel, each writes `vote`
  └── architecture voter  ┘
        └── majority_vote → consensus
```

A single node. The voters are synthetic sub-nodes the executor creates, not
entries in the graph topology.

## Lifecycle & State

| Key | Written by | Contents |
| --- | --- | --- |
| `review-vote_votes` | voting node | every voter's raw vote |
| `review-vote_consensus` | voting node | the aggregated result |

Both are implied write grants, so the node declares no `writes`. Each voter is
granted only `vote_key` internally.

## Run

```bash
ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/voting/voting.ts

# or free, against a local model:
CYCGRAPH_MODEL=qwen2.5:7b npx tsx examples/voting/voting.ts
```

## Expected Output

```
Status: completed

Individual Votes:
  <agent-id>: {"decision":"approve","reasoning":"…"}
  <agent-id>: {"decision":"approve","reasoning":"…"}
  <agent-id>: {"decision":"approve","reasoning":"…"}

Consensus:
  {"decision":"approve","reasoning":"…"}
```

## Notes

**Quorum** is set to 2 of 3, so the node still produces a consensus when one
voter fails or times out. Below quorum it raises rather than reporting a
result derived from too little evidence.

**Strategies.** `majority_vote` counts verdicts. `weighted_vote` takes a
per-agent `weights` map. `llm_judge` hands the votes to a `judge` agent to
arbitrate, and requires one.

This example runs through an explicit `GraphRunner` rather than `run()`,
because it inspects the final `WorkflowState` for status and token totals,
which the one-call helper does not expose.
