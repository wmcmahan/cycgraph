# Types — Technical Reference

> **Scope**: This document covers the Zod schema definitions and TypeScript types that form the type system of `@cycgraph/orchestrator`. All schemas enforce runtime validation at system boundaries.

---

## Overview

The types module defines the core domain model via Zod schemas. Every type is both a compile-time TypeScript interface (via `z.infer`) and a runtime validator. This eliminates the common drift between documented types and actual runtime behavior.

| File | Purpose |
|------|---------|
| `state.ts` | `WorkflowState`, `Action`, `StateView`, `TaintMetadata` |
| `graph.ts` | `Graph`, `GraphNode`, `GraphEdge`, all node config schemas |
| `event.ts` | `WorkflowEvent`, `NewWorkflowEvent`, `EventType` (event sourcing) |
| `index.ts` | Barrel re-export of all type files |

---

## WorkflowState (`state.ts`)

The shared "blackboard" that all nodes read from and write to. This is the single source of truth for a workflow execution.

### Schema: `WorkflowStateSchema`

All temporal fields use coercing schemas (`z.coerce.date()`), so state loaded from JSON/jsonb storage round-trips back to real `Date` objects. Load state through `hydrateWorkflowState()` (which also applies schema migrations) rather than casting raw rows.

| Field | Type | Default | Purpose |
|-------|------|---------|---------|
| `state_schema_version` | `number` | `1` | Schema version; `hydrateWorkflowState()` migrates older snapshots forward and refuses newer ones |
| `workflow_id` | `string (uuid)` | *required* | Links to graph definition |
| `run_id` | `string (uuid)` | *required* | Unique execution run |
| `created_at` | `Date` | *required* | When the run was created |
| `updated_at` | `Date` | *required* | Last state mutation timestamp |
| `_last_event_sequence_id` | `number?` | — | Runner-managed event-log high-water mark at persist time (crash-window idempotency) |
| `goal` | `string` | *required* | User's objective |
| `constraints` | `string[]` | `[]` | Restrictions on execution |
| `status` | `WorkflowStatus` | *required* | Current state machine position |
| `current_node` | `string?` | — | Node currently executing |
| `iteration_count` | `number` | `0` | Total iterations completed |
| `retry_count` | `number` | `0` | Consecutive retry count |
| `max_retries` | `number` | `3` | Max retries before failure |
| `last_error` | `string?` | — | Most recent error message |
| `waiting_for` | `WaitingReason?` | — | Why workflow is paused |
| `waiting_since` | `Date?` | — | When pause started |
| `waiting_timeout_at` | `Date?` | — | When pause auto-expires |
| `started_at` | `Date?` | — | Execution start timestamp |
| `max_execution_time_ms` | `number` | `3600000` (1h) | Global timeout |
| `memory` | `Record<string, unknown>` | `{}` | Dynamic working memory |
| `total_tokens_used` | `number` | `0` | Cumulative token usage |
| `max_token_budget` | `number?` | — | Token limit (fails when exceeded) |
| `visited_nodes` | `string[]` | `[]` | Execution path for debugging |
| `max_iterations` | `number` | `50` | Iteration safety limit |
| `compensation_stack` | `Array<{action_id, compensation_action: {type, payload}}>` | `[]` | Typed saga rollback stack |
| `supervisor_history` | `Array<{supervisor_id, delegated_to, reasoning, iteration, timestamp}>` | `[]` | Supervisor routing decisions |

### WorkflowStatus (9-state machine)

```
pending → scheduled → running → waiting/retrying → completed/failed/cancelled/timeout
```

| Status | Category | Description |
|--------|----------|-------------|
| `pending` | Initial | Created but not started |
| `scheduled` | Initial | Waiting for scheduled start time |
| `running` | Active | Currently executing |
| `waiting` | Active | Paused (HITL, external event, rate limit) |
| `retrying` | Active | Failed step, attempting retry |
| `completed` | Terminal | Successfully finished |
| `failed` | Terminal | Unrecoverable error |
| `cancelled` | Terminal | User/system cancelled |
| `timeout` | Terminal | Exceeded max execution time |

### WaitingReason

`human_approval` | `external_event` | `scheduled_time` | `rate_limit` | `resource_limit`

---

## Action (`state.ts`)

The universal output type for all node executors. Actions are the **only** way to mutate workflow state.

### Schema: `ActionSchema`

| Field | Type | Purpose |
|-------|------|---------|
| `id` | `string (uuid)` | Unique action identifier |
| `type` | `string` | Action type (`update_memory`, `set_status`, `handoff`, etc.) |
| `payload` | `Record<string, unknown>` | Type-specific data |
| `idempotency_key` | `string` | Prevents duplicate execution on retry/resume |
| `compensation` | `{ type, payload }?` | Saga pattern rollback action |
| `metadata.node_id` | `string` | Which node produced this action |
| `metadata.agent_id` | `string?` | Which agent produced this action |
| `metadata.timestamp` | `Date` | When the action was created |
| `metadata.attempt` | `number` | Retry attempt number (default: 1) |
| `metadata.duration_ms` | `number?` | Execution time |
| `metadata.token_usage` | `{ inputTokens?, outputTokens?, totalTokens }?` | LLM token consumption |
| `metadata.tool_executions` | `Array<{ tool, args, result }>?` | Tool calls made during execution |

---

## StateView (`state.ts`)

A security-filtered projection of `WorkflowState`. Constructed by the `GraphRunner` using the node's `read_keys`.

```typescript
interface StateView {
  workflow_id: string;
  run_id: string;
  goal: string;
  constraints: string[];
  memory: Record<string, unknown>; // Only includes keys from agent's read_keys
}
```

---

## TaintMetadata (`state.ts`)

Provenance metadata attached to memory keys containing external data.

```typescript
interface TaintMetadata {
  source: 'mcp_tool' | 'tool_node' | 'agent_response' | 'derived';
  tool_name?: string;
  agent_id?: string;
  created_at: string; // ISO date string
}

type TaintRegistry = Record<string, TaintMetadata>;
```

Stored at `memory._taint_registry`. Keys prefixed with `_` are system-reserved and cannot be written by agents.

---

## Graph (`graph.ts`)

The complete graph definition that the `GraphRunner` executes.

### Schema: `GraphSchema`

| Field | Type | Default | Purpose |
|-------|------|---------|---------|
| `id` | `string` | *required* | Graph identifier |
| `name` | `string` | *required* | Human-readable name |
| `description` | `string` | *required* | What this workflow does |
| `version` | `string` | `"1.0.0"` | Semantic version |
| `nodes` | `GraphNode[]` | *required* | Node definitions |
| `edges` | `GraphEdge[]` | *required* | Connections between nodes |
| `start_node` | `string` | *required* | Entry point node ID |
| `end_nodes` | `string[]` | *required* | Terminal node IDs |
| `created_at` | `Date` | *required* | Creation timestamp |
| `updated_at` | `Date` | *required* | Last modification |

---

## GraphNode (`graph.ts`)

### Schema: `GraphNodeSchema`

| Field | Type | Default | Purpose |
|-------|------|---------|---------|
| `id` | `string` | *required* | Unique node identifier |
| `type` | `NodeType` | *required* | One of 10 node types (see below) |
| `agent_id` | `string?` | — | Agent config ID (for agent/supervisor nodes) |
| `tool_id` | `string?` | — | Tool identifier (for tool nodes) |
| `subgraph_config` | `SubgraphConfig?` | — | Nested workflow config |
| `supervisor_config` | `SupervisorConfig?` | — | Supervisor routing config |
| `approval_config` | `ApprovalGateConfig?` | — | HITL gate config |
| `annealing_config` | `AnnealingConfig?` | — | Self-annealing loop config |
| `map_reduce_config` | `MapReduceConfig?` | — | Fan-out parallel config |
| `voting_config` | `VotingConfig?` | — | Consensus/voting config |
| `swarm_config` | `SwarmConfig?` | — | Peer delegation config |
| `evolution_config` | `EvolutionConfig?` | — | DGM evolution config |
| `read_keys` | `string[]` | `["*"]` | Memory keys the node can read |
| `write_keys` | `string[]` | `[]` | Memory keys the node can write |
| `failure_policy` | `FailurePolicy` | `{ max_retries: 3, backoff_strategy: "exponential" }` | Resilience settings |
| `requires_compensation` | `boolean` | `false` | Saga pattern participation |
| `metadata` | `Record?` | — | Arbitrary metadata |

### NodeType (10 types)

`agent` | `tool` | `subgraph` | `synthesizer` | `router` | `supervisor` | `map` | `voting` | `approval` | `evolution`

---

## Node Config Schemas (`graph.ts`)

### SupervisorConfig

| Field | Type | Default | Purpose |
|-------|------|---------|---------|
| `agent_id` | `string` | *required* | LLM agent for routing decisions |
| `managed_nodes` | `string[]` | *required* | Node IDs this supervisor can delegate to |
| `max_iterations` | `number` | `10` | Safety limit on routing iterations |
| `completion_condition` | `string?` | — | Optional expression for forced completion |

### ApprovalGateConfig

| Field | Type | Default | Purpose |
|-------|------|---------|---------|
| `approval_type` | `'human_review'` | `'human_review'` | Type of approval |
| `prompt_message` | `string` | Default review prompt | Shown to the reviewer |
| `review_keys` | `string[]` | `["*"]` | Memory keys reviewer sees |
| `timeout_ms` | `number` | `86400000` (24h) | Auto-rejection timeout |
| `rejection_node_id` | `string?` | — | Node to route to on rejection |

### AnnealingConfig

| Field | Type | Default | Purpose |
|-------|------|---------|---------|
| `evaluator_agent_id` | `string?` | — | Agent for quality evaluation |
| `score_path` | `string` | `"$.score"` | JSONPath to extract score from output |
| `threshold` | `number (0-1)` | `0.8` | Quality threshold to stop |
| `max_iterations` | `number` | `5` | Max annealing iterations |
| `initial_temperature` | `number (0-2)` | `1.0` | Starting LLM temperature |
| `final_temperature` | `number (0-2)` | `0.2` | Ending LLM temperature |
| `diminishing_returns_delta` | `number` | `0.02` | Stop if improvement is below delta |

### MapReduceConfig

| Field | Type | Default | Purpose |
|-------|------|---------|---------|
| `worker_node_id` | `string` | *required* | Node to fan out to |
| `items_path` | `string?` | — | JSONPath to items array in memory |
| `static_items` | `unknown[]?` | — | Alternative: hardcoded items |
| `synthesizer_node_id` | `string?` | — | Node to fan results into |
| `error_strategy` | `'fail_fast' \| 'best_effort'` | `'best_effort'` | Error handling |
| `max_concurrency` | `number` | `5` | Max parallel workers |

### VotingConfig

| Field | Type | Default | Purpose |
|-------|------|---------|---------|
| `voter_agent_ids` | `string[]` | *required* | Agent IDs that vote |
| `strategy` | `'majority_vote' \| 'weighted_vote' \| 'llm_judge'` | `'majority_vote'` | Aggregation method |
| `vote_key` | `string` | `'vote'` | Memory key for each vote |
| `quorum` | `number?` | — | Minimum votes required |
| `judge_agent_id` | `string?` | — | Required for `llm_judge` strategy |
| `weights` | `Record<string, number>?` | — | Per-agent weights for `weighted_vote` |

### SwarmConfig

| Field | Type | Default | Purpose |
|-------|------|---------|---------|
| `peer_nodes` | `string[]` | *required* | Peer agent node IDs |
| `max_handoffs` | `number` | `10` | Max peer delegations |
| `handoff_mode` | `'agent_choice'` | `'agent_choice'` | How peers are selected |

### EvolutionConfig (DGM)

| Field | Type | Default | Purpose |
|-------|------|---------|---------|
| `candidate_agent_id` | `string` | *required* | Agent that generates candidate solutions |
| `evaluator_agent_id` | `string` | *required* | Agent that scores candidates (0-1) |
| `population_size` | `number (≥2)` | `5` | Candidates per generation |
| `max_generations` | `number` | `10` | Maximum generations |
| `fitness_threshold` | `number (0-1)` | `0.9` | Early exit when score exceeds this |
| `stagnation_generations` | `number` | `3` | Stop if no improvement for N gens |
| `selection_strategy` | `'rank' \| 'tournament' \| 'roulette'` | `'rank'` | Parent selection method |
| `elite_count` | `number` | `1` | Top candidates preserved across generations |
| `initial_temperature` | `number (0-2)` | `1.0` | Starting temperature (diversity) |
| `final_temperature` | `number (0-2)` | `0.3` | Ending temperature (exploitation) |
| `tournament_size` | `number (≥2)` | `3` | For `tournament` strategy |
| `max_concurrency` | `number` | `5` | Max parallel candidate evaluations |
| `error_strategy` | `'fail_fast' \| 'best_effort'` | `'best_effort'` | Error handling |
| `evaluation_criteria` | `string?` | — | Custom instruction for fitness evaluator |

### SubgraphConfig

| Field | Type | Default | Purpose |
|-------|------|---------|---------|
| `subgraph_id` | `string` | *required* | Graph ID to load and execute |
| `input_mapping` | `Record<string, string>` | `{}` | Parent memory key → child memory key |
| `output_mapping` | `Record<string, string>` | `{}` | Child memory key → parent memory key |
| `max_iterations` | `number` | `50` | Child workflow iteration limit |

---

## GraphEdge (`graph.ts`)

### Schema: `GraphEdgeSchema`

| Field | Type | Default | Purpose |
|-------|------|---------|---------|
| `id` | `string` | *required* | Unique edge identifier |
| `source` | `string` | *required* | Source node ID |
| `target` | `string` | *required* | Target node ID |
| `condition` | `EdgeCondition` | `{ type: "always" }` | When to follow this edge |
| `metadata` | `Record?` | — | Arbitrary metadata |

### EdgeCondition

| Field | Type | Purpose |
|-------|------|---------|
| `type` | `'always' \| 'conditional' \| 'map'` | Condition type |
| `condition` | `string?` | Filtrex expression (for `conditional` type) |
| `value` | `unknown?` | Optional static value |

---

## FailurePolicy (`graph.ts`)

### Schema: `FailurePolicySchema`

| Field | Type | Default | Purpose |
|-------|------|---------|---------|
| `max_retries` | `number` | `3` | Maximum retry attempts |
| `backoff_strategy` | `'linear' \| 'exponential' \| 'fixed'` | `'exponential'` | Delay calculation |
| `initial_backoff_ms` | `number` | `1000` | First retry delay |
| `max_backoff_ms` | `number` | `60000` | Maximum retry delay |
| `circuit_breaker` | `CircuitBreakerConfig?` | — | Optional circuit breaker |
| `timeout_ms` | `number?` | — | Per-node timeout |

### CircuitBreakerConfig

| Field | Type | Default | Purpose |
|-------|------|---------|---------|
| `enabled` | `boolean` | `false` | Whether breaker is active |
| `failure_threshold` | `number` | `5` | Open after N failures |
| `success_threshold` | `number` | `2` | Close after N successes |
| `timeout_ms` | `number` | `60000` | Half-open test timeout |

---

## WorkflowEvent (`event.ts`)

Event sourcing types for durable execution. Events are appended to an immutable log during workflow execution and replayed through pure reducers during crash recovery.

### EventType

`workflow_started` | `node_started` | `action_dispatched` | `internal_dispatched` | `state_persisted`

### Schema: `WorkflowEventSchema`

| Field | Type | Purpose |
|-------|------|---------|
| `id` | `string (uuid)` | Unique event identifier |
| `run_id` | `string (uuid)` | Which workflow run this event belongs to |
| `sequence_id` | `number (int >= 0)` | Monotonic ordering within a run |
| `event_type` | `EventType` | Discriminator for the event kind |
| `node_id` | `string?` | Which node produced this event |
| `action` | `Action?` | Full action payload (for `action_dispatched` events) |
| `internal_type` | `string?` | Internal dispatch type (`_init`, `_advance`, `_complete`) |
| `internal_payload` | `Record<string, unknown>?` | Internal dispatch payload |
| `created_at` | `Date` | When the event was recorded |

The combination of `run_id` + `sequence_id` uniquely identifies an event and defines the replay order. Events with `action` payloads contain the full serialized Action (including LLM responses) so that replay skips expensive re-computation.

### NewWorkflowEvent

Input shape for appending events — same as `WorkflowEvent` but without `id` and `created_at` (auto-generated).
