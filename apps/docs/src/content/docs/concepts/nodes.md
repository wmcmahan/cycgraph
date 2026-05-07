---
title: Nodes
description: Node types, configuration, state slicing, failure policies, and subgraphs.
---

A **Node** is a unit of work that is executed by the graph. It can be a single agent, a tool, a router, or any other type of node.

## Node configuration

| Field | Type | Description |
|------|-------------|-------------|
| `id` | `string` | The ID of the node. |
| `type` | `string` | The type of the node. |
| `agent_id` | `string` | The ID of the agent to run (`agent`, `supervisor`, `synthesizer` nodes). |
| `tool_id` | `string` | The tool to execute (`tool` nodes). |
| `tools` | `Array<ToolSource>` | Tool sources for this node. Overrides agent config tools when set. |
| `subgraph_id` | `string` | The ID of the graph to embed (`subgraph` nodes). |
| `subgraph_config` | `SubgraphConfig` | Input/output mapping and iteration limits (`subgraph` nodes). |
| `supervisor_config` | `SupervisorConfig` | Managed nodes and iteration limits (`supervisor` nodes). |
| `approval_config` | `ApprovalGateConfig` | Approval type, review keys, and timeout (`approval` nodes). |
| `map_reduce_config` | `MapReduceConfig` | Worker node, items path, concurrency, and error strategy (`map` nodes). |
| `voting_config` | `VotingConfig` | Voter agents, aggregation strategy, and quorum (`voting` nodes). |
| `annealing_config` | `AnnealingConfig` | Self-annealing iterative refinement (`agent` nodes). |
| `swarm_config` | `SwarmConfig` | Swarm peer delegation (`agent` nodes). |
| `evolution_config` | `EvolutionConfig` | Population size, fitness evaluation, and selection strategy (`evolution` nodes). |
| `read_keys` | `Array<string>` | The keys to read from the state. |
| `write_keys` | `Array<string>` | The keys to write to the state. |
| `failure_policy` | `FailurePolicy` | The failure policy for the node. |
| `requires_compensation` | `boolean` | Whether the node requires compensation. |

## Node types

| Type | Description |
|------|-------------|
| `agent` | Runs an LLM with tools via `streamText`. The workhorse of the system. |
| `tool` | Executes a specific MCP tool directly, without an LLM. |
| `router` | Evaluates a state expression and routes to the matching target node. |
| `supervisor` | LLM-powered dynamic routing — delegates to managed nodes iteratively. |
| `approval` | Pauses the workflow for human review. Resumes when approved or rejected. |
| `map` | Fans out work to parallel workers (one per item). |
| `synthesizer` | Merges parallel outputs into a single result using an LLM agent. |
| `voting` | Multiple agents vote on a decision to reach consensus. |
| `subgraph` | Delegates to a nested graph with isolated state. Input/output mapping between parent and child. |
| `evolution` | Population-based selection — runs N candidates, scores fitness, breeds next generation. |

## State slicing

Nodes declare which state keys they can read and write:

`read_keys: ['goal', 'notes']` — the node sees only these keys from state
<br>
`write_keys: ['draft']` — the node can only write to these keys
<br>
`read_keys: ['*']` / `write_keys: ['*']` — Allow all state access (use sparingly)

This enforces the **principle of least privilege** — a writer agent can't read database credentials, and a researcher can't overwrite the final draft.

## Compensation (Saga pattern)

Nodes can opt into compensation for rollback support by setting `requires_compensation: true`. If the workflow fails after a compensatable node completes, the orchestrator executes the `compensation_stack` in reverse order — unwinding side effects like a database transaction rollback.

## Failure policy

Controls retry behaviour when a node fails. Applied per-node.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `max_retries` | `number` | `3` | Maximum retry attempts before the node fails permanently. |
| `backoff_strategy` | `'linear' \| 'exponential' \| 'fixed'` | `'exponential'` | Delay growth between retries. |
| `initial_backoff_ms` | `number` | `1000` | Initial delay between retries (ms). |
| `max_backoff_ms` | `number` | `60000` | Maximum delay cap (ms). |
| `timeout_ms` | `number` | — | Per-node execution timeout (ms). |
| `circuit_breaker` | `object` | — | Trip after repeated failures, auto-recover via half-open probes. |

### Circuit breaker

Optional. Prevents repeatedly calling a failing external service.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | `boolean` | `false` | Whether the circuit breaker is active. |
| `failure_threshold` | `number` | `5` | Consecutive failures before the circuit opens. |
| `success_threshold` | `number` | `2` | Consecutive successes to close the circuit. |
| `timeout_ms` | `number` | `60000` | Half-open probe timeout (ms). |

---

## Node-specific configurations

Each node type has an optional config block that controls its behaviour. These are set as top-level fields on the node object (e.g. `supervisor_config`, `subgraph_config`).

### `supervisor_config`

Used by `supervisor` nodes. The supervisor LLM dynamically routes work between managed sub-nodes until a completion condition is met or the iteration limit is reached.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `agent_id` | `string` | — | Agent ID for the routing LLM. Falls back to `node.agent_id` if omitted. |
| `managed_nodes` | `string[]` | *required* | Node IDs this supervisor can delegate to. |
| `max_iterations` | `number` | `10` | Max routing iterations before forced completion (loop guard). |
| `completion_condition` | `string` | — | JSONPath expression that, when truthy, signals completion. |

### `subgraph_config`

Used by `subgraph` nodes. Executes an entire nested workflow as a single step, with isolated state and explicit memory mapping.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `subgraph_id` | `string` | *required* | ID of the graph to embed (loaded via `loadGraphFn`). |
| `input_mapping` | `Record<string, string>` | `{}` | Maps parent memory keys → child memory keys. |
| `output_mapping` | `Record<string, string>` | `{}` | Maps child memory keys → parent memory keys. |
| `max_iterations` | `number` | `50` | Iteration cap for the child workflow. |

The child gets a **fresh, isolated** `WorkflowState`. Only mapped keys cross the boundary. The child inherits the parent's remaining token budget. A `_subgraph_stack` prevents cyclic nesting (e.g. `A → B → A` throws immediately).

### `approval_config`

Used by `approval` nodes. Pauses execution until a human reviewer approves or rejects.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `approval_type` | `'human_review'` | `'human_review'` | Type of approval required. |
| `prompt_message` | `string` | `'Please review and approve this workflow step.'` | Message shown to the reviewer. |
| `review_keys` | `string[]` | `['*']` | Memory keys the reviewer should see. |
| `timeout_ms` | `number` | `86400000` (24h) | Timeout before auto-rejection. |
| `rejection_node_id` | `string` | — | Node to route to on rejection. If unset, the workflow fails. |

### `map_reduce_config`

Used by `map` nodes. Fans out work to parallel workers, then optionally fans in via a synthesizer.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `worker_node_id` | `string` | *required* | Node ID of the worker to fan out to. |
| `items_path` | `string` | — | JSONPath to extract the items array from memory. |
| `static_items` | `unknown[]` | — | Static items array (alternative to `items_path`). |
| `synthesizer_node_id` | `string` | — | Node ID of the synthesizer to fan results into. |
| `error_strategy` | `'fail_fast' \| 'best_effort'` | `'best_effort'` | How to handle worker errors. |
| `max_concurrency` | `number` | `5` | Maximum concurrent workers. |

### `voting_config`

Used by `voting` nodes. Multiple agents vote independently and a strategy aggregates the results.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `voter_agent_ids` | `string[]` | *required* | Agent IDs that will vote (min 1). |
| `strategy` | `'majority_vote' \| 'weighted_vote' \| 'llm_judge'` | `'majority_vote'` | Aggregation strategy. |
| `vote_key` | `string` | `'vote'` | Memory key where each voter writes their vote. |
| `quorum` | `number` | — | Minimum votes required for a valid result. |
| `judge_agent_id` | `string` | — | Agent ID for the `llm_judge` strategy. |
| `weights` | `Record<string, number>` | — | Per-agent weights for `weighted_vote`. |

### `annealing_config`

Used by `agent` nodes for iterative self-refinement. Progressively lowers the LLM temperature and re-evaluates until a quality threshold is met.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `evaluator_agent_id` | `string` | — | Agent ID for the evaluator. Falls back to `score_path` extraction. |
| `score_path` | `string` | `'$.score'` | JSONPath to extract a numeric score from agent output. |
| `threshold` | `number` | `0.8` | Quality threshold (0–1) to stop iteration. |
| `max_iterations` | `number` | `5` | Maximum annealing iterations. |
| `initial_temperature` | `number` | `1.0` | Starting LLM temperature. |
| `final_temperature` | `number` | `0.2` | Ending temperature (converges toward this). |
| `diminishing_returns_delta` | `number` | `0.02` | Stop if score improvement is less than this delta. |

### `swarm_config`

Used by agent nodes in swarm mode. Peer agents hand off work to each other until the task is complete.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `peer_nodes` | `string[]` | *required* | Node IDs of peer agents in the swarm. |
| `max_handoffs` | `number` | `10` | Maximum handoffs before forcing completion. |
| `handoff_mode` | `'agent_choice'` | `'agent_choice'` | How peers are selected for handoff. |

### `evolution_config`

Used by `evolution` nodes. Population-based optimization — generates N candidates, scores fitness, selects the best, and breeds the next generation.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `population_size` | `number` | `5` | Number of candidates per generation (min 2). |
| `candidate_agent_id` | `string` | *required* | Agent that generates candidate solutions. |
| `evaluator_agent_id` | `string` | *required* | Agent that scores fitness. |
| `selection_strategy` | `'rank' \| 'tournament' \| 'roulette'` | `'rank'` | How parents are selected. |
| `elite_count` | `number` | `1` | Top candidates preserved unchanged across generations. |
| `max_generations` | `number` | `10` | Maximum number of generations. |
| `fitness_threshold` | `number` | `0.9` | Fitness score (0–1) for early exit. |
| `stagnation_generations` | `number` | `3` | Stop if no improvement for this many generations. |
| `initial_temperature` | `number` | `1.0` | Starting temperature (diversity). |
| `final_temperature` | `number` | `0.3` | Ending temperature (exploitation). |
| `tournament_size` | `number` | `3` | Tournament size for `tournament` strategy. |
| `max_concurrency` | `number` | `5` | Max concurrent candidate evaluations. |
| `error_strategy` | `'fail_fast' \| 'best_effort'` | `'best_effort'` | How to handle candidate generation errors. |
| `evaluation_criteria` | `string` | — | Custom instruction passed to the fitness evaluator. |

## Next steps

- [Graphs](/concepts/graphs/) — graph structure and edge configuration
- [Workflow State](/concepts/workflow-state/) — the shared state object
- [Agents](/concepts/agents/) — how agent nodes work

