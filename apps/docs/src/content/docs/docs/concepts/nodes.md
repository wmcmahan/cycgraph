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
| `a2a` | Delegates to a remote agent over the Agent2Agent protocol. |
| `evolution` | Population-based selection: runs N candidates, scores fitness, breeds the next generation. |
| `verifier` | Gates a target memory key against a verification predicate. |
| `reflection` | Distills source memory keys into atomic facts and persists them via a memory writer. |

Each type's config block is documented under [Interfaces](#interfaces).

## State slicing

Nodes declare which state keys they can read and write with `reads` and `writes`.

```typescript
const research = node({ /* ... */ writes: 'notes' });

const write = node({
  // ...
  reads: [research.writes],
  writes: 'draft',
});
```

An authored node carries the keys it writes, so a reader names them instead of
retyping the string: `research.writes` here, `fan.results` on a map node,
`gate.verification` on a verifier. A typo becomes a compile error, and renaming
a node updates its readers.

Both `read` and `write` fields default to an empty list, least privilege, and a node that omits `reads` sees only `goal` and `constraints`, which are always available, and one that omits `writes` can write nothing. Because of that default, a node that consumes an upstream node's output must declare it. A writer reading research notes needs `reads: ['notes']`.

`reads: ['*']` allows full memory access. `validateGraph` warns on wildcard reads because they defeat state slicing; reserve them for nodes that genuinely need every prior output, such as a final summarizer.

This enforces the principle of least privilege, as a writer agent can't read database credentials, and a researcher can't overwrite the final draft.

Several grants are derived and never need declaring. Control-flow permissions follow from the node's type: a supervisor may route and complete, approval and subgraph nodes may pause, and a swarm agent may hand off. The result keys a node's own executor writes are implied by its config: a verifier's result pair, a reflection envelope, a tool node's `${id}_result`, and fan-out aggregate keys. And a supervisor with no declared `reads` derives them from its team, `goal`, `constraints`, and everything its `managedNodes` write. `writes` is for what the node's *agent* writes.

`validateGraph` also warns when a declared read key is not produced by any node in the graph, whether declared, implied, or a default write key. This is usually a typo that would otherwise surface as a silently empty value at runtime. Keys seeded through initial workflow memory are the legitimate exception, which is why this is a warning rather than an error. Declare those in the graph's `inputs` and set `strictKeys: true` to make the check an error instead.

It also warns when `reads` lists `goal` or `constraints`. Both reach every node whatever its grants say, so naming them grants nothing and suggests a permission was needed.

## Compensation (saga)

Nodes can opt into compensation for rollback support by setting `requiresCompensation: true`. If the workflow fails after a compensatable node completes, the orchestrator executes the `compensation_stack` in reverse order, unwinding side effects the way a database transaction rollback would. See [Error Handling](/docs/concepts/error-handling/#compensation--saga-rollback) for the full saga flow.

## Resilience

Every node carries a failure policy that controls how the runner handles a failure. On a retryable error, the runner retries up to max retries times with backoff (exponential by default). An optional per-node circuit breaker trips after repeated failures and auto-recovers through half-open probes, which prevents hammering a failing external service.

A node can also declare a budget that caps the tokens or USD a single execution may spend. This guards against a runaway annealing loop or an oversized reflection extraction eating the whole workflow budget. Breaching either cap throws `NodeBudgetExceededError` and stops the workflow immediately with no retry, since a retry would just compound the spend. Workflow-level budgets (`WorkflowState.budgetUsd`, `maxTokenBudget`) remain enforced independently.

```typescript
const reflect = reflection(['notes'], {
  id: 'reflect',
  reads: ['notes'],
  extractor: { type: 'rule_based' },
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
node<const S extends NodeSpec>(spec: S): NodeValue & OutputsFor<S> & Pick<S, 'writes'>
```

##### Options

The input is a [NodeSpec](#nodespec).

Every node type has a helper that leads with what it delegates to and takes its config flat, rather than nested under a `*Config` block. All of them return a `NodeValue` and compile to the same wire shape `node()` produces, so they can be mixed freely. Fields common to every node — `id`, `reads`, `failurePolicy`, `budget`, `metadata`, `requiresCompensation` — are accepted by all of them.

### `supervisor`

Route work to other nodes with an LLM. See the [Supervisor pattern](/docs/patterns/supervisor/).

```typescript
supervisor(brain: AgentValue | string, spec: SupervisorSpec): NodeValue
```

| Field | Maps to | Description |
|-------|---------|-------------|
| `manages` | `managedNodes` | Nodes it may delegate to, by value or id. |
| `maxIterations` | `maxIterations` | Routing turns before forced completion. |
| `writes` | `writeKeys` | Keys the supervisor's agent may write. |
| `memoryQuery` | `memoryQuery` | Retrieval directive applied before the routing prompt. |

Omit `reads` to derive them from the managed nodes' writes.

### `mapReduce`

Fan out over a collection, then fan back in. See the [Map-Reduce pattern](/docs/patterns/map-reduce/).

```typescript
mapReduce(worker: NodeValue | string, spec: MapReduceSpec): NodeValue & MapOutputs
```

| Field | Maps to | Description |
|-------|---------|-------------|
| `items` | `itemsPath` / `staticItems` | A JSONPath into memory, or a literal array. The form decides which. |
| `into` | `synthesizerNodeId` | Synthesizer the results fan into. |
| `concurrency` | `maxConcurrency` | Workers in flight at once. |
| `maxItems` | `maxItems` | Hard cap on items fanned out. |
| `onError` | `errorStrategy` | `'fail_fast'` or `'best_effort'`. |

### `voting`

Run several agents on the same task and aggregate. See the [Voting pattern](/docs/patterns/voting/).

```typescript
voting(voters: (AgentValue | string)[], spec: VotingSpec): NodeValue & VotingOutputs
```

| Field | Maps to | Description |
|-------|---------|-------------|
| `strategy` | `strategy` | `'majority_vote'`, `'weighted_vote'`, or `'llm_judge'`. |
| `voteKey` | `voteKey` | Key each voter writes its vote to. |
| `quorum` | `quorum` | Votes required before a result counts. |
| `judge` | `judgeAgentId` | Arbitrating agent. Required by `'llm_judge'`. |
| `weights` | `weights` | Per-agent weights for `'weighted_vote'`. |

### `evolution`

Population-based selection over generations. See the [Evolution pattern](/docs/patterns/evolution/).

```typescript
evolution(candidate: AgentValue | string, spec: EvolutionSpec): NodeValue & EvolutionOutputs
```

| Field | Maps to | Description |
|-------|---------|-------------|
| `evaluator` | `evaluatorAgentId` | Scoring agent. Omit only when a `fitnessFunction` is wired on the runner. |
| `populationSize` | `populationSize` | Candidates per generation. |
| `maxGenerations` | `maxGenerations` | Generations before the loop stops. |
| `fitnessThreshold` | `fitnessThreshold` | Early exit. Above `1.0` disables it. |
| `selection` | `selectionStrategy` | `'rank'`, `'tournament'`, or `'roulette'`. |
| `concurrency` | `maxConcurrency` | Candidates evaluated at once. |
| `criteria` | `evaluationCriteria` | Extra instruction for the evaluator. |
| `onError` | `errorStrategy` | `'fail_fast'` or `'best_effort'`. |

Also accepts `eliteCount`, `stagnationGenerations`, `initialTemperature`, `finalTemperature`, `tournamentSize`, and `taskTimeoutMs`, which map by name.

### `verifier`

Check a memory value and record a structured outcome. Three variants on one namespace, all writing the same pair of keys. See the [Verifier pattern](/docs/patterns/verifier/).

```typescript
verifier.llmJudge(judge: AgentValue | string, spec): NodeValue & VerifierOutputs
verifier.expression(expression: string, spec): NodeValue & VerifierOutputs
verifier.jsonPath(target: string, spec): NodeValue & VerifierOutputs
```

| Field | Variant | Description |
|-------|---------|-------------|
| `target` | `llmJudge` | Memory key whose value is scored. |
| `threshold` | `llmJudge` | Pass when the score is at or above this. |
| `criteria` | `llmJudge` | Extra instruction for the judge. |
| `path`, `assertion` | `jsonPath` | JSONPath and the assertion applied to the result. |
| `resultKey` | all | Key prefix for the outcome. Defaults to `${id}_verification`. |
| `throwOnFail` | all | Throw on failure to trigger retry, instead of routing on `_passed`. |

### `reflection`

Distill memory into facts a later run can retrieve. See the [Reflection pattern](/docs/patterns/reflection/).

```typescript
reflection(sources: string[], spec: ReflectionSpec): NodeValue & ReflectionOutputs
```

| Field | Maps to | Description |
|-------|---------|-------------|
| `extractor` | `extractor` | `{ type: 'rule_based' }` or `{ type: 'llm', agentId }`. |
| `tags` | `tags` | Applied to every written fact. Namespace them. |
| `entityKeys` | `entityKeys` | Keys naming entities the facts relate to. |
| `resultKey` | `resultKey` | Pins the envelope key. Defaults to `${id}_reflection`. |

### `runTool`

Run one tool as a deterministic step, with no model involved. The node's `reads` slice is passed to the tool as its argument object.

```typescript
runTool(toolId: string, spec: RunToolSpec): NodeValue & ToolOutputs
```

### `approval`

Pause until a human decides. See the [Human-in-the-Loop pattern](/docs/patterns/human-in-the-loop/).

```typescript
approval(spec: ApprovalSpec): NodeValue
```

| Field | Maps to | Description |
|-------|---------|-------------|
| `prompt` | `promptMessage` | Message shown to the reviewer. |
| `reviewKeys` | `reviewKeys` | Memory keys the reviewer sees. |
| `timeoutMs` | `timeoutMs` | How long before the gate auto-rejects. |
| `onReject` | `rejectionNodeId` | Where a rejection routes. Without it, a rejected run fails. |

### `subgraph`

Embed a child graph as one node. See the [Subgraph pattern](/docs/patterns/subgraph/).

```typescript
subgraph<const S extends SubgraphSpec>(child: Graph | GraphBundle | string, spec: S): NodeValue & MappedOutputsFor<S>
```

| Field | Maps to | Description |
|-------|---------|-------------|
| `inputs` | `inputMapping` | Parent key → child key. |
| `outputs` | `outputMapping` | Child key → parent key. Also the write grant. |
| `maxIterations` | `maxIterations` | Iteration cap for the child. |

### `a2a`

Delegate to a remote agent. See the [A2A pattern](/docs/patterns/a2a/).

```typescript
a2a<const S extends A2ASpec>(serverId: string, spec: S): NodeValue & MappedOutputsFor<S>
```

| Field | Maps to | Description |
|-------|---------|-------------|
| `inputs` | `inputMapping` | Memory key → message part. |
| `outputs` | `outputMapping` | Artifact name → memory key. Also the write grant. |
| `skill` | `skillId` | Which advertised skill this node intends to invoke. |
| `maxWaitMs` | `maxWaitMs` | How long to wait for a terminal state. |

`budget` is not accepted here: a remote agent reports no usage, so a per-node cap could never fire.

### `router` and `synthesizer`

Neither takes a config block.

```typescript
router(spec: RouterSpec): NodeValue
synthesizer(spec: SynthesizerSpec): NodeValue & SynthesizerOutputs
```

`router` is a branch point; its routing lives on the outgoing edges' conditions. `synthesizer` merges fan-out results, deterministically when no `agent` is given and as a written synthesis when one is. An agent-backed synthesizer authors its own output, so it needs `writes`.

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

A string enum of the executor kinds. Each value is described in [Node types](#node-types) above: `agent`, `tool`, `router`, `supervisor`, `approval`, `map`, `synthesizer`, `voting`, `subgraph`, `a2a`, `evolution`, `verifier`, `reflection`.

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

### A2AConfig

Used by `a2a` nodes. Delegates a step to a remote agent over the Agent2Agent protocol. The endpoint and credentials are resolved from the trusted A2A server registry, never from the graph. See the [A2A pattern](/docs/patterns/a2a/) and the `a2a()` authoring helper.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `serverId` | `string` | *required* | Registry id of the remote server. Never a URL. |
| `inputMapping` | `Record<string, string>` | `{}` | Maps memory keys to outbound message parts. |
| `outputMapping` | `Record<string, string>` | `{}` | Maps returned artifact names to memory keys. |
| `skillId` | `string` | — | Which advertised skill this node intends to invoke. Recorded for readers; not sent on the wire. |
| `maxWaitMs` | `number` | — | How long to wait for a terminal state. Falls back to the registry entry's `taskTimeoutMs`. |

Everything the remote agent returns is taint-tracked as external data. Budget and capability ceilings stop at the network, so `maxWaitMs` and the failure policy are the only bounds. A task ending `rejected` or `auth-required` is not retried; one stopping at `input-required` pauses the workflow and resumes the same remote task.

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
