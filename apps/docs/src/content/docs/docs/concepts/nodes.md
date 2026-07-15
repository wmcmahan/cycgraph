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
| `agentId` | `string` | The ID of the agent to run. |
| `toolId` | `string` | The tool to execute. |
| `tools` | `Array<ToolSource>` | Tool sources for this node. Overrides agent config tools when set. |
| `subgraphId` | `string` | The ID of the graph to embed (`subgraph` nodes). |
| `subgraphConfig` | `SubgraphConfig` | Input/output mapping and iteration limits (`subgraph` nodes). |
| `supervisorConfig` | `SupervisorConfig` | Managed nodes and iteration limits (`supervisor` nodes). |
| `approvalConfig` | `ApprovalGateConfig` | Approval type, review keys, and timeout (`approval` nodes). |
| `mapReduceConfig` | `MapReduceConfig` | Worker node, items path, concurrency, and error strategy (`map` nodes). |
| `votingConfig` | `VotingConfig` | Voter agents, aggregation strategy, and quorum (`voting` nodes). |
| `annealingConfig` | `AnnealingConfig` | Self-annealing iterative refinement (`agent` nodes). |
| `swarmConfig` | `SwarmConfig` | Swarm peer delegation (`agent` nodes). |
| `evolutionConfig` | `EvolutionConfig` | Population size, fitness evaluation, and selection strategy (`evolution` nodes). |
| `verifierConfig` | `VerifierConfig` | Verification predicate — LLM judge, expression, or JSONPath assertion (`verifier` nodes). |
| `reflectionConfig` | `ReflectionConfig` | Source keys, extractor variant, and tags for compound learning (`reflection` nodes). |
| `memoryQuery` | `MemoryQuery` | Per-node retrieval directive. When set, the runner calls `memoryRetriever` before building the agent / supervisor prompt and renders results into a `## Relevant Memory` section. |
| `readKeys` | `Array<string>` | The keys to read from the state. |
| `writeKeys` | `Array<string>` | The keys to write to the state. |
| `defaultWriteKey` | `string` | Memory key for orchestrator-managed text output when an agent doesn't call `save_to_memory`. Must be a member of `writeKeys`. |
| `failurePolicy` | `FailurePolicy` | The failure policy for the node. |
| `budget` | `NodeBudget` | Per-node resource caps (`maxTokens`, `maxCostUsd`). Breaching either throws `NodeBudgetExceededError`. |
| `requiresCompensation` | `boolean` | Whether the node requires compensation. |

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
| `verifier` | Gates a target memory key against a verification predicate (LLM judge, filtrex expression, or JSONPath assertion). |
| `reflection` | Distills source memory keys into atomic facts and persists them via `memoryWriter` — feeds future runs of the graph that declare a matching `memoryQuery`. |

## State slicing

Nodes declare which state keys they can read and write. Both **default to `[]` (least privilege)** — a node that omits `readKeys` sees only `goal` and `constraints`, and one that omits `writeKeys` can write nothing. Opt into exactly what each node needs:

`readKeys: ['goal', 'notes']` — the node sees only these keys from memory (plus `goal`/`constraints`, which are always available)
<br>
`writeKeys: ['draft']` — the node can only write to these keys
<br>
`readKeys: ['*']` / `writeKeys: ['*']` — allow all memory access. `validateGraph` emits a warning for any node using `['*']` reads, since it defeats state slicing; reserve it for nodes that genuinely need every prior output (e.g. a final summarizer).

This enforces the **principle of least privilege** — a writer agent can't read database credentials, and a researcher can't overwrite the final draft. Because the default is `[]`, a node that consumes an upstream node's output **must declare it**: a writer reading research notes needs `readKeys: ['notes']`, not the implicit full access of earlier versions.

## Compensation (Saga pattern)

Nodes can opt into compensation for rollback support by setting `requiresCompensation: true`. If the workflow fails after a compensatable node completes, the orchestrator executes the `compensation_stack` in reverse order — unwinding side effects like a database transaction rollback.

## Failure policy

Controls retry behaviour when a node fails. Applied per-node.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `maxRetries` | `number` | `3` | Maximum retry attempts before the node fails permanently. |
| `backoffStrategy` | `'linear' \| 'exponential' \| 'fixed'` | `'exponential'` | Delay growth between retries. |
| `initialBackoffMs` | `number` | `1000` | Initial delay between retries (ms). |
| `maxBackoffMs` | `number` | `60000` | Maximum delay cap (ms). |
| `timeoutMs` | `number` | — | Per-node execution timeout (ms). |
| `circuitBreaker` | `object` | — | Trip after repeated failures, auto-recover via half-open probes. |

### Per-node budget

Caps a single node's resource consumption. Useful for guarding against a runaway annealing loop or an oversized LLM reflection extraction eating the whole workflow budget.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `maxTokens` | `number` | — | Cap on tokens used by this node's execution. |
| `maxCostUsd` | `number` | — | Cap on USD spent by this node's execution. |

Breaching either cap throws `NodeBudgetExceededError` and stops the workflow immediately — **no retry**, since a retry would just compound the spend. Workflow-level budgets (`WorkflowState.budget_usd`, `max_token_budget`) remain enforced independently.

```typescript
{
  id: 'reflect',
  type: 'reflection',
  readKeys: ['notes'],
  writeKeys: ['reflect_reflection'],
  reflectionConfig: { /* … */ },
  budget: {
    maxTokens: 20_000,
    maxCostUsd: 0.10,
  },
}
```

### Circuit breaker

Optional. Prevents repeatedly calling a failing external service.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | `boolean` | `false` | Whether the circuit breaker is active. |
| `failureThreshold` | `number` | `5` | Consecutive failures before the circuit opens. |
| `successThreshold` | `number` | `2` | Consecutive successes to close the circuit. |
| `timeoutMs` | `number` | `60000` | Half-open probe timeout (ms). |

---

## Node-specific configurations

Each node type has an optional config block that controls its behaviour. These are set as top-level fields on the node object (e.g. `supervisorConfig`, `subgraphConfig`).

### `supervisorConfig`

Used by `supervisor` nodes. The supervisor LLM dynamically routes work between managed sub-nodes until a completion condition is met or the iteration limit is reached.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `agentId` | `string` | — | Agent ID for the routing LLM. Falls back to `node.agentId` if omitted. |
| `managedNodes` | `string[]` | *required* | Node IDs this supervisor can delegate to. |
| `maxIterations` | `number` | `10` | Max routing iterations before forced completion (loop guard). |
| `completionCondition` | `string` | — | JSONPath expression that, when truthy, signals completion. |

### `subgraphConfig`

Used by `subgraph` nodes. Executes an entire nested workflow as a single step, with isolated state and explicit memory mapping.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `subgraphId` | `string` | *required* | ID of the graph to embed (loaded via `loadGraphFn`). |
| `inputMapping` | `Record<string, string>` | `{}` | Maps parent memory keys → child memory keys. |
| `outputMapping` | `Record<string, string>` | `{}` | Maps child memory keys → parent memory keys. |
| `maxIterations` | `number` | `50` | Iteration cap for the child workflow. |

The child gets a **fresh, isolated** `WorkflowState`. Only mapped keys cross the boundary. The child inherits the parent's remaining token budget. A `_subgraph_stack` prevents cyclic nesting (e.g. `A → B → A` throws immediately).

### `approvalConfig`

Used by `approval` nodes. Pauses execution until a human reviewer approves or rejects.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `approvalType` | `'human_review'` | `'human_review'` | Type of approval required. |
| `promptMessage` | `string` | `'Please review and approve this workflow step.'` | Message shown to the reviewer. |
| `reviewKeys` | `string[]` | `['*']` | Memory keys the reviewer should see. |
| `timeoutMs` | `number` | `86400000` (24h) | Timeout before auto-rejection. |
| `rejectionNodeId` | `string` | — | Node to route to on rejection. If unset, the workflow fails. |

### `mapReduceConfig`

Used by `map` nodes. Fans out work to parallel workers, then optionally fans in via a synthesizer.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `workerNodeId` | `string` | *required* | Node ID of the worker to fan out to. |
| `itemsPath` | `string` | — | JSONPath to extract the items array from memory. |
| `staticItems` | `unknown[]` | — | Static items array (alternative to `itemsPath`). |
| `synthesizerNodeId` | `string` | — | Node ID of the synthesizer to fan results into. |
| `errorStrategy` | `'fail_fast' \| 'best_effort'` | `'best_effort'` | How to handle worker errors. |
| `maxConcurrency` | `number` | `5` | Maximum concurrent workers. |

### `votingConfig`

Used by `voting` nodes. Multiple agents vote independently and a strategy aggregates the results.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `voterAgentIds` | `string[]` | *required* | Agent IDs that will vote (min 1). |
| `strategy` | `'majority_vote' \| 'weighted_vote' \| 'llm_judge'` | `'majority_vote'` | Aggregation strategy. |
| `voteKey` | `string` | `'vote'` | Memory key where each voter writes their vote. |
| `quorum` | `number` | — | Minimum votes required for a valid result. |
| `judgeAgentId` | `string` | — | Agent ID for the `llm_judge` strategy. |
| `weights` | `Record<string, number>` | — | Per-agent weights for `weighted_vote`. |

### `annealingConfig`

Used by `agent` nodes for iterative self-refinement. Progressively lowers the LLM temperature and re-evaluates until a quality threshold is met.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `evaluatorAgentId` | `string` | — | Agent ID for the evaluator. Falls back to `scorePath` extraction. |
| `scorePath` | `string` | `'$.score'` | JSONPath to extract a numeric score from agent output. |
| `threshold` | `number` | `0.8` | Quality threshold (0–1) to stop iteration. |
| `maxIterations` | `number` | `5` | Maximum annealing iterations. |
| `initialTemperature` | `number` | `1.0` | Starting LLM temperature. |
| `finalTemperature` | `number` | `0.2` | Ending temperature (converges toward this). |
| `diminishingReturnsDelta` | `number` | `0.02` | Stop if score improvement is less than this delta. |

### `swarmConfig`

Used by agent nodes in swarm mode. Peer agents hand off work to each other until the task is complete.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `peerNodes` | `string[]` | *required* | Node IDs of peer agents in the swarm. |
| `maxHandoffs` | `number` | `10` | Maximum handoffs before forcing completion. |
| `handoffMode` | `'agent_choice'` | `'agent_choice'` | How peers are selected for handoff. |

### `evolutionConfig`

Used by `evolution` nodes. Population-based optimization — generates N candidates, scores fitness, selects the best, and breeds the next generation.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `populationSize` | `number` | `5` | Number of candidates per generation (min 2). |
| `candidateAgentId` | `string` | *required* | Agent that generates candidate solutions. |
| `evaluatorAgentId` | `string` | *required* | Agent that scores fitness. |
| `selectionStrategy` | `'rank' \| 'tournament' \| 'roulette'` | `'rank'` | How parents are selected. |
| `eliteCount` | `number` | `1` | Top candidates preserved unchanged across generations. |
| `maxGenerations` | `number` | `10` | Maximum number of generations. |
| `fitnessThreshold` | `number` | `0.9` | Fitness score (0–1) for early exit. |
| `stagnationGenerations` | `number` | `3` | Stop if no improvement for this many generations. |
| `initialTemperature` | `number` | `1.0` | Starting temperature (diversity). |
| `finalTemperature` | `number` | `0.3` | Ending temperature (exploitation). |
| `tournamentSize` | `number` | `3` | Tournament size for `tournament` strategy. |
| `maxConcurrency` | `number` | `5` | Max concurrent candidate evaluations. |
| `errorStrategy` | `'fail_fast' \| 'best_effort'` | `'best_effort'` | How to handle candidate generation errors. |
| `evaluationCriteria` | `string` | — | Custom instruction passed to the fitness evaluator. |

### `verifierConfig`

Used by `verifier` nodes. Gates a target memory key against a verification predicate. Three flavours via a discriminated union on `type`:

#### `type: 'llm_judge'`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `targetKey` | `string` | *required* | Memory key whose value is evaluated. |
| `evaluatorAgentId` | `string` | *required* | Agent ID for the LLM-as-judge evaluator. |
| `passThreshold` | `number` | `0.8` | Pass when the evaluator's score (0–1) is ≥ this threshold. |
| `evaluationCriteria` | `string` | — | Custom instruction passed to the evaluator. |

#### `type: 'expression'`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `expression` | `string` | *required* | Filtrex expression evaluated against `{ memory, goal }`. Passes when truthy. |

#### `type: 'jsonpath'`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `targetKey` | `string` | *required* | Memory key whose value is queried. |
| `path` | `string` | *required* | JSONPath expression against `memory[targetKey]`. |
| `assertion` | `JsonPathAssertion` | *required* | One of `exists`, `equals`, `matches`, `gt`, `gte`, `lt`, `lte`. |

#### Common fields (all variants)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `resultKey` | `string` | `{node.id}_verification` | Memory key the structured result envelope is written to. Also writes `{resultKey}_passed` boolean for routing. |
| `throwOnFail` | `boolean` | `false` | When `true`, the node throws on failure (engages `failurePolicy` retry). When `false`, downstream edges route on `{resultKey}_passed`. |

### `reflectionConfig`

Used by `reflection` nodes. Distills `sourceKeys` from workflow memory into atomic `SemanticFacts` and persists them via the injected `memoryWriter`. Pairs with `memoryQuery` on downstream nodes to close the compound-learning loop.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `sourceKeys` | `string[]` | *required* (min 1) | Memory keys whose values feed the extractor. Must be declared in the node's `readKeys`. |
| `extractor` | `RuleBasedExtractor \| LLMExtractor` | *required* | Extraction strategy (see below). |
| `tags` | `string[]` | `[]` | Tags applied to every fact written. Namespace by graph (`graph:my-graph-v1`) or category (`lesson`, `failure`) so downstream retrieval can scope. |
| `entityKeys` | `string[]` | — | Memory keys whose string values name entities the produced facts relate to. Linked into the knowledge graph for entity-driven retrieval. |
| `resultKey` | `string` | `{node.id}_reflection` | Memory key the structured `ReflectionResult` envelope is written to. |

#### `extractor: { type: 'rule_based' }`

Deterministic sentence-level extraction. No LLM call.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `minSentenceLength` | `number` | `15` | Minimum sentence length (chars) to qualify as a fact. |

#### `extractor: { type: 'llm' }`

Uses the `extractFactsExecutor` primitive to distill structured lessons via an LLM.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `agentId` | `string` | *required* | Agent ID for the LLM extractor. |
| `maxFacts` | `number` | `10` | Soft cap on facts returned (1–50). |
| `instruction` | `string` | — | Optional override for the default lesson-distillation prompt. |

### `memoryQuery`

Used by `agent`, `supervisor`, and any wrapper-agent node (annealing, map worker, swarm, synthesizer, voting voter, evolution candidate). When set, the runner calls `memoryRetriever` once before building the node's prompt and renders the result into a `## Relevant Memory` section.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `text` | `string` | `stateView.goal` *(only when no other field is set)* | Natural-language semantic query. |
| `entityIds` | `string[]` | — | Seed entity IDs for knowledge-graph subgraph extraction. |
| `tags` | `string[]` | — | Restrict matches to facts carrying at least one of these tags. |
| `maxFacts` | `number` | — | Soft cap on facts injected into the prompt. |
| `untrusted` | `boolean` | `false` | Treat retrieved content as untrusted (e.g. RAG over user-uploaded or web documents). When `true` and facts are injected, the agent's outputs are marked tainted (`source: 'retrieval'`) so a poisoned document can't drive a downstream sensitive action ungated. Leave `false` for trusted internal knowledge / the agent's own reflection memory. |

**Routing rule:** if `text`, `entityIds`, or `tags` is set, retrieval uses that knob explicitly. Only when **none** of them are set does the runtime default `text` to `stateView.goal` (zero-config RAG). Voting and evolution nodes propagate `memoryQuery` automatically to their synthetic sub-nodes.

## Next steps

- [Graphs](/docs/concepts/graphs/) — graph structure and edge configuration
- [Workflow State](/docs/concepts/workflow-state/) — the shared state object
- [Agents](/docs/concepts/agents/) — how agent nodes work

