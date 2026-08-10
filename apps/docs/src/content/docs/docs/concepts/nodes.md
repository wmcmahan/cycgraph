---
title: Nodes
description: Node types, configuration, state slicing, failure policies, and subgraphs.
---

A **Node** is a unit of work the graph executes. It can be a single agent, a tool call, a router, a human-approval gate, or any of the other node types.

```typescript
import { agent, node } from '@cycgraph/orchestrator';

const researchNode = node({
  id: 'research',
  agent: agent({
    model: 'claude-sonnet-4-6',
    instructions: 'You are a research specialist. Produce concise, factual notes.',
  }),
  reads: ['goal'],
  writes: 'notes',
});
```

The full field reference is in [Interfaces](#nodespec) below.

## Node types

| Type | Description |
|------|-------------|
| `agent` | Runs an LLM with tools. The workhorse of the system. |
| `tool` | Executes a specific tool or MCP. |
| `router` | Evaluates a state expression and routes to the matching target node. |
| `supervisor` | LLM-powered dynamic routing. Delegates to managed nodes iteratively. |
| `approval` | Pauses the workflow for human review. Resumes when approved or rejected. |
| `map` | Fans out work to parallel workers. |
| `synthesizer` | Merges parallel outputs into a single result using an LLM agent. |
| `voting` | Multiple agents vote on a decision to reach consensus. |
| `subgraph` | Delegates to a nested graph with isolated state and input/output mapping. |
| `evolution` | Population-based selection: runs N candidates, scores fitness, breeds the next generation. |
| `verifier` | Gates a target memory key against a verification predicate. |
| `reflection` | Distills source memory keys into atomic facts and persists them via a memory writer. |

Each type's config block is documented under [Interfaces](#interfaces).

## State slicing

Nodes declare which state keys they can read and write with `reads` and `writes`.

```typescript
const write = node({
  // ...
  reads: ['goal', 'notes'],
  writes: 'draft',
});
```

Both `read` and `write` fields default to an empty list, least privilege, and a node that omits `reads` sees only `goal` and `constraints`, which are always available, and one that omits `writes` can write nothing. Because of that default, a node that consumes an upstream node's output must declare it. A writer reading research notes needs `reads: ['notes']`.

`reads: ['*']` allows full memory access. `validateGraph` warns on wildcard reads because they defeat state slicing; reserve them for nodes that genuinely need every prior output, such as a final summarizer.

This enforces the principle of least privilege, as a writer agent can't read database credentials, and a researcher can't overwrite the final draft.

Several grants are derived and never need declaring. Control-flow permissions follow from the node's type: a supervisor may route and complete, approval and subgraph nodes may pause, and a swarm agent may hand off. The result keys a node's own executor writes are implied by its config: a verifier's result pair, a reflection envelope, a tool node's `${id}_result`, and fan-out aggregate keys. And a supervisor with no declared `reads` derives them from its team, `goal`, `constraints`, and everything its `managedNodes` write. `writes` is for what the node's *agent* writes.

`validateGraph` also warns when a declared read key is not produced by any node in the graph, whether declared, implied, or a default write key. This is usually a typo that would otherwise surface as a silently empty value at runtime. Keys seeded through initial workflow memory are the legitimate exception, which is why this is a warning rather than an error.

## Compensation (saga)

Nodes can opt into compensation for rollback support by setting `requiresCompensation: true`. If the workflow fails after a compensatable node completes, the orchestrator executes the `compensation_stack` in reverse order, unwinding side effects the way a database transaction rollback would. See [Error Handling](/docs/concepts/error-handling/#compensation--saga-rollback) for the full saga flow.

## Resilience

Every node carries a failure policy that controls how the runner handles a failure. On a retryable error, the runner retries up to max retries times with backoff (exponential by default). An optional per-node circuit breaker trips after repeated failures and auto-recovers through half-open probes, which prevents hammering a failing external service.

A node can also declare a budget that caps the tokens or USD a single execution may spend. This guards against a runaway annealing loop or an oversized reflection extraction eating the whole workflow budget. Breaching either cap throws `NodeBudgetExceededError` and stops the workflow immediately with no retry, since a retry would just compound the spend. Workflow-level budgets (`WorkflowState.budgetUsd`, `maxTokenBudget`) remain enforced independently.

```typescript
const reflect = node({
  id: 'reflect',
  type: 'reflection',
  reads: ['notes'],
  reflectionConfig: { /* … */ },
  budget: {
    maxTokens: 20_000,
    maxCostUsd: 0.10,
  },
});
```

**Refs:**
- [FailurePolicy](#failurepolicy): Retry, backoff, timeout, and circuit-breaker fields.
- [NodeBudget](#nodebudget): Per-node token and cost caps.

## API

### `node`

Author a graph node as a placement value: a topology id, state grants, and which agent runs there. It is the facade counterpart of a raw node config and compiles to the same [GraphNode](#graphnode) wire shape when [graph](/docs/concepts/graphs/#graph) builds the graph.

```typescript
node(spec: NodeSpec): NodeValue
```

##### Options

The input is a [NodeSpec](#nodespec).

## Interfaces

### NodeSpec

The authoring input to [node](#node).

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `id` | `string` | *required* | Unique node identifier. |
| `agent` | `AgentValue \| string` | — | The agent to run. |
| `type` | [`NodeType`](#nodetype) | Selects the node's executor. Required for non-agent nodes. |
| `reads` | `string[]` | `[]` | Memory keys this node may read. |
| `writes` | `string \| string[]` | `[]` | Memory key(s) this node may write. |


### GraphNode

The common shape shared by every node. Type-specific behavior comes from the optional config block that matches the node's type.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `id` | `string` | *required* | Unique node identifier. |
| `type` | [`NodeType`](#nodetype) | *required* | Selects the node's executor. |
| `agentId` | `string` | — | Agent to run. |
| `toolId` | `string` | — | Tool to execute. |
| `tools` | [`ToolSource[]`](/docs/concepts/tools-and-mcp/) | — | Tool sources for this node. Overrides the agent's configured tools when set. |
| `subgraphId` | `string` | — | Graph to embed as a subgraph. |
| `subgraphConfig` | [`SubgraphConfig`](#subgraphconfig) | — | Input/output mapping and iteration limits for the subgraph. |
| `supervisorConfig` | [`SupervisorConfig`](#supervisorconfig) | — | Managed nodes and iteration limits for supervisor nodes. |
| `approvalConfig` | [`ApprovalGateConfig`](#approvalgateconfig) | — | Approval type, review keys, and timeout for approval nodes. |
| `mapReduceConfig` | [`MapReduceConfig`](#mapreduceconfig) | — | Worker node, items path, concurrency, and error strategy for map nodes. |
| `votingConfig` | [`VotingConfig`](#votingconfig) | — | Voter agents, aggregation strategy, and quorum for voting nodes. |
| `annealingConfig` | [`AnnealingConfig`](#annealingconfig) | — | Iterative self-refinement for agent nodes. |
| `swarmConfig` | [`SwarmConfig`](#swarmconfig) | — | Peer delegation for agent` nodes in swarm mode. |
| `evolutionConfig` | [`EvolutionConfig`](#evolutionconfig) | — | Population size, fitness evaluation, and selection strategy (`evolution` nodes). |
| `verifierConfig` | [`VerifierConfig`](#verifierconfig) | — | Verification predicate for verifier nodes. |
| `reflectionConfig` | [`ReflectionConfig`](#reflectionconfig) | — | Source keys, extractor variant, and tags for reflection nodes. |
| `memoryQuery` | [`MemoryQuery`](#memoryquery) | — | Per-node retrieval directive. |
| `readKeys` | `string[]` | `[]` | Memory keys this node may read. See [State slicing](#state-slicing). |
| `writeKeys` | `string[]` | `[]` | Memory keys this node may write. |
| `defaultWriteKey` | `string` | — | Memory key for orchestrator-managed text output when an agent doesn't call `save_to_memory`. Must be a member of `writeKeys`. |
| `failurePolicy` | [`FailurePolicy`](#failurepolicy) | see below | Retry and backoff configuration. |
| `budget` | [`NodeBudget`](#nodebudget) | — | Per-node token and cost caps. |
| `requiresCompensation` | `boolean` | `false` | Whether the node pushes a compensating action for saga rollback. |
| `metadata` | `Record<string, unknown>` | — | Arbitrary metadata for tooling and debugging. |

### NodeType

A string enum of the executor kinds. Each value is described in [Node types](#node-types) above: `agent`, `tool`, `router`, `supervisor`, `approval`, `map`, `synthesizer`, `voting`, `subgraph`, `evolution`, `verifier`, `reflection`.

### FailurePolicy

Per-node retry behavior. Defaults apply when the node omits `failurePolicy`.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `maxRetries` | `number` | `3` | Maximum retry attempts before the node fails permanently (0–10). |
| `backoffStrategy` | `'linear' \| 'exponential' \| 'fixed'` | `'exponential'` | Delay growth between retries. |
| `initialBackoffMs` | `number` | `1000` | Initial delay between retries. |
| `maxBackoffMs` | `number` | `60000` | Maximum delay cap. |
| `timeoutMs` | `number` | — | Per-node execution timeout. |
| `circuitBreaker` | [`CircuitBreaker`](#circuitbreaker) | — | Trip after repeated failures, auto-recover via half-open probes. |

### CircuitBreaker

Optional block on `failurePolicy`. Prevents repeatedly calling a failing external service.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | `boolean` | `false` | Whether the circuit breaker is active. |
| `failureThreshold` | `number` | `5` | Consecutive failures before the circuit opens. |
| `successThreshold` | `number` | `2` | Consecutive successes to close the circuit. |
| `timeoutMs` | `number` | `60000` | Half-open probe timeout. |

### NodeBudget

Per-node resource caps. Breaching either throws `NodeBudgetExceededError` and stops the run with no retry. Both are optional; set the caps that matter.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `maxTokens` | `number` | — | Cap on tokens used by this node's execution. |
| `maxCostUsd` | `number` | — | Cap on USD spent by this node's execution. |

### SupervisorConfig

Used by `supervisor` nodes. The supervisor LLM dynamically routes work between managed sub-nodes until it decides the goal is met or the iteration limit is reached.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `agentId` | `string` | — | Agent ID for the routing LLM. Falls back to `node.agentId` if omitted. |
| `managedNodes` | `string[]` | *required* | Node IDs this supervisor can delegate to. |
| `maxIterations` | `number` | `10` | Max routing iterations before forced completion (loop guard). |

### SubgraphConfig

Used by subgraph nodes. Executes an entire child graph as a single step, with isolated state and explicit memory mapping. This is the engine's composition primitive: a graph becomes a reusable block another graph embeds, and the way to extend a graph you did not write is to wrap it in one of these. See the [Subgraph pattern](/docs/patterns/subgraph/) for composition and the `subgraph()` authoring helper.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `subgraphId` | `string` | *required* | ID of the graph to embed (loaded via `loadGraph`). |
| `inputMapping` | `Record<string, string>` | `{}` | Maps parent memory keys to child memory keys. |
| `outputMapping` | `Record<string, string>` | `{}` | Maps child memory keys to parent memory keys. |
| `maxIterations` | `number` | `50` | Iteration cap for the child workflow. |

The child gets a fresh, isolated `WorkflowState`. Only mapped keys cross the boundary. The child inherits the parent's remaining token budget. The `subgraphStack` state field prevents cyclic nesting, so `A → B → A` throws immediately.

### ApprovalGateConfig

Used by `approval` nodes. Pauses execution until a human reviewer approves or rejects.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `approvalType` | `'human_review'` | `'human_review'` | Type of approval required. |
| `promptMessage` | `string` | `'Please review and approve this workflow step.'` | Message shown to the reviewer. |
| `reviewKeys` | `string[]` | `['*']` | Memory keys the reviewer should see. |
| `timeoutMs` | `number` | `86400000` (24h) | Timeout before auto-rejection. |
| `rejectionNodeId` | `string` | — | Node to route to on rejection. If unset, the workflow fails. |

### MapReduceConfig

Used by `map` nodes. Fans out work to parallel workers, then optionally fans in via a synthesizer.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `workerNodeId` | `string` | *required* | Node ID of the worker to fan out to. |
| `itemsPath` | `string` | — | JSONPath to extract the items array from memory. |
| `staticItems` | `unknown[]` | — | Static items array. |
| `synthesizerNodeId` | `string` | — | Node ID of the synthesizer to fan results into. |
| `errorStrategy` | `'fail_fast' \| 'best_effort'` | `'best_effort'` | How to handle worker errors. |
| `maxConcurrency` | `number` | `5` | Maximum concurrent workers. |

### VotingConfig

Used by `voting` nodes. Multiple agents vote independently and a strategy aggregates the results.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `voterAgentIds` | `string[]` | *required* | Agent IDs that will vote (min 1). |
| `strategy` | `'majority_vote' \| 'weighted_vote' \| 'llm_judge'` | `'majority_vote'` | Aggregation strategy. |
| `voteKey` | `string` | `'vote'` | Memory key where each voter writes their vote. |
| `quorum` | `number` | — | Minimum votes required for a valid result. |
| `judgeAgentId` | `string` | — | Agent ID for the `llm_judge` strategy. |
| `weights` | `Record<string, number>` | — | Per-agent weights for `weighted_vote`. |

### AnnealingConfig

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

### SwarmConfig

Used by `agent` nodes in swarm mode. Peer agents hand off work to each other until the task is complete.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `peerNodes` | `string[]` | *required* | Node IDs of peer agents in the swarm. |
| `maxHandoffs` | `number` | `10` | Maximum handoffs before forcing completion. |
| `handoffMode` | `'agent_choice'` | `'agent_choice'` | How peers are selected for handoff. |

### EvolutionConfig

Used by `evolution` nodes. Population-based optimization that generates N candidates, scores fitness, selects the best, and breeds the next generation.

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
| `tournamentSize` | `number` | `3` | Tournament size for the `tournament` strategy. |
| `maxConcurrency` | `number` | `5` | Max concurrent candidate evaluations. |
| `errorStrategy` | `'fail_fast' \| 'best_effort'` | `'best_effort'` | How to handle candidate generation errors. |
| `evaluationCriteria` | `string` | — | Custom instruction passed to the fitness evaluator. |

### VerifierConfig

Used by `verifier` nodes. Gates a target memory key against a verification predicate. It is a discriminated union on `type` with three variants, plus fields common to all of them.

**`type: 'llm_judge'`**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `targetKey` | `string` | *required* | Memory key whose value is evaluated. |
| `evaluatorAgentId` | `string` | *required* | Agent ID for the LLM-as-judge evaluator. |
| `passThreshold` | `number` | `0.8` | Pass when the evaluator's score (0–1) is ≥ this threshold. |
| `evaluationCriteria` | `string` | — | Custom instruction passed to the evaluator. |

**`type: 'expression'`**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `expression` | `string` | *required* | Filtrex expression evaluated against `{ memory, goal }`. Passes when truthy. |

**`type: 'jsonpath'`**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `targetKey` | `string` | *required* | Memory key whose value is queried. |
| `path` | `string` | *required* | JSONPath expression against `memory[targetKey]`. |
| `assertion` | `JsonPathAssertion` | *required* | One of `exists`, `equals`, `matches`, `gt`, `gte`, `lt`, `lte`. |

**Common fields (all variants)**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `resultKey` | `string` | `{node.id}_verification` | Memory key the structured result envelope is written to. Also writes a `{resultKey}_passed` boolean for routing. |
| `throwOnFail` | `boolean` | `false` | When `true`, the node throws on failure (engaging `failurePolicy` retry). When `false`, downstream edges route on `{resultKey}_passed`. |

### ReflectionConfig

Used by `reflection` nodes. Distills `sourceKeys` from workflow memory into atomic `SemanticFacts` and persists them via the injected `memoryWriter`. Pairs with `memoryQuery` on downstream nodes to close the compound-learning loop.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `sourceKeys` | `string[]` | *required* (min 1) | Memory keys whose values feed the extractor. Must be declared in the node's `readKeys`. |
| `extractor` | [rule-based](#extractor-rule_based) or [LLM](#extractor-llm) | *required* | Extraction strategy. |
| `tags` | `string[]` | `[]` | Tags applied to every fact written. Namespace by graph (`graph:my-graph-v1`) or category (`lesson`, `failure`) so downstream retrieval can scope. |
| `entityKeys` | `string[]` | — | Memory keys whose string values name entities the produced facts relate to. Linked into the knowledge graph for entity-driven retrieval. |
| `resultKey` | `string` | `{node.id}_reflection` | Memory key the structured `ReflectionResult` envelope is written to. |

#### extractor: rule_based

Deterministic sentence-level extraction. No LLM call.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `type` | `'rule_based'` | *required* | Selects rule-based extraction. |
| `minSentenceLength` | `number` | `15` | Minimum sentence length (chars) to qualify as a fact. |

#### extractor: llm

Uses the `extractFactsExecutor` primitive to distill structured lessons via an LLM.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `type` | `'llm'` | *required* | Selects LLM extraction. |
| `agentId` | `string` | *required* | Agent ID for the LLM extractor. |
| `maxFacts` | `number` | `10` | Soft cap on facts returned (1–50). |
| `instruction` | `string` | — | Optional override for the default lesson-distillation prompt. |

### MemoryQuery

Used by `agent`, `supervisor`, and any wrapper-agent node (annealing, map worker, swarm, synthesizer, voting voter, evolution candidate). When set, the runner calls `memoryRetriever` once before building the node's prompt and renders the result into a `## Relevant Memory` section.

Compound-pattern executors additionally deliver per-invocation inputs (the map item, the evolution parent and its critique, annealing feedback, swarm peers) through a separate `## Task Context` prompt section. That context is ephemeral: it never touches the memory blackboard and needs no `readKeys` entry.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `text` | `string` | `stateView.goal` *(only when no other field is set)* | Natural-language semantic query. |
| `entityIds` | `string[]` | — | Seed entity IDs for knowledge-graph subgraph extraction. |
| `tags` | `string[]` | — | Restrict matches to facts carrying at least one of these tags. |
| `maxFacts` | `number` | — | Soft cap on facts injected into the prompt. |
| `untrusted` | `boolean` | `false` | Treat retrieved content as untrusted, such as RAG over user-uploaded or web documents. When `true` and facts are injected, the agent's outputs are marked tainted (`source: 'retrieval'`) so a poisoned document can't drive a downstream sensitive action ungated. Leave `false` for trusted internal knowledge or the agent's own reflection memory. |

**Routing rule:** if `text`, `entityIds`, or `tags` is set, retrieval uses that knob explicitly. Only when **none** of them are set does the runtime default `text` to `stateView.goal` (zero-config RAG). Voting and evolution nodes propagate `memoryQuery` automatically to their synthetic sub-nodes.

## Next steps

- [Graphs](/docs/concepts/graphs/): graph structure and edge configuration
- [Graph Runner](/docs/concepts/graph-runner/): the engine that executes nodes
- [Workflow State](/docs/concepts/workflow-state/): the shared state object
- [Agents](/docs/concepts/agents/): how agent nodes work
