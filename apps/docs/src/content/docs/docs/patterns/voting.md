---
title: Voting / Consensus
description: Multiple agents vote independently on the same task, and a strategy aggregates their answers into a single consensus result.
---

The **Voting / Consensus** pattern runs several agents on the *same* task in parallel, then aggregates their independent answers into one result. It trades extra inference cost for reliability: instead of trusting a single model call, you sample many and let a strategy decide the winner.

This is the classic remedy for high-variance tasks — classification, extraction, judgement calls — where any one sample might be wrong but the majority is usually right.

## How it works

```mermaid
flowchart TB
    Task(["Task"]) --> V1["Voter A"]
    Task --> V2["Voter B"]
    Task --> V3["Voter C"]
    V1 --> Agg{"Aggregate<br/>strategy"}
    V2 --> Agg
    V3 --> Agg
    Agg --> Consensus(["Consensus"])
```

1. **Fan out**: every agent in `voter_agent_ids` runs the task in parallel, each writing its answer to `vote_key`.
2. **Collect**: the node gathers each voter's payload (votes are compared by a canonical, order-independent serialization, so structurally-equal answers count as equal).
3. **Aggregate**: the chosen `strategy` reduces the votes to a single consensus.
4. **Write**: the result is written back to memory for downstream nodes.

### Strategies

| Strategy | How the winner is chosen |
|----------|--------------------------|
| `majority_vote` (default) | The answer returned by the most voters wins. |
| `weighted_vote` | Votes are summed using per-agent `weights`; highest total wins. |
| `llm_judge` | A `judge_agent_id` reviews all votes and decides the consensus. |

## Implementation example

The `voting` node type requires a `voting_config` block listing the voters and the aggregation strategy.

```typescript
{
  id: 'classify',
  type: 'voting',
  read_keys: ['ticket_text'],
  write_keys: ['classify_consensus', 'classify_votes'],
  voting_config: {
    voter_agent_ids: [CLASSIFIER_A, CLASSIFIER_B, CLASSIFIER_C],
    strategy: 'majority_vote',
    vote_key: 'category',
    quorum: 2,
  },
}
```

For a `weighted_vote`, supply `weights` keyed by agent ID; for `llm_judge`, supply a `judge_agent_id`:

```typescript
voting_config: {
  voter_agent_ids: [JUNIOR, SENIOR, STAFF],
  strategy: 'weighted_vote',
  vote_key: 'verdict',
  weights: { [JUNIOR]: 1, [SENIOR]: 2, [STAFF]: 3 },
}
```

:::note
Each voter is an independent agent run. A `memory_query` declared on the voting node propagates to every voter, so they all see the same retrieved memory. Use `task_timeout_ms` to guard against a single hung voter stalling the round.
:::

## Outputs

The node writes two keys into `WorkflowState.memory`:

- `{nodeId}_consensus` — the aggregated answer.
- `{nodeId}_votes` — the full array of individual votes (for auditing and traceability).

Both must be declared in the node's `write_keys`.

## When to use it

- **High-stakes classification or extraction** where a single sample is too risky.
- **LLM-as-judge disagreements** — let several judges vote rather than trusting one.
- **Reducing variance** on tasks where the same prompt yields different answers across runs.

For *iteratively improving* a single answer rather than sampling many, reach for [Evolution](/docs/patterns/evolution/) or [Self-Annealing](/docs/patterns/self-annealing/) instead. To *check* an answer against a standard rather than vote on it, see [Verifier](/docs/patterns/verifier/).
