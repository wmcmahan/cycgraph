---
title: Counterfactual Replay
description: Fork a recorded run at any point, change one thing, and re-run only the part the change could affect.
---

Take a run that already happened, change one thing about it, and run only the part that the change could affect. Then read what became different.

```typescript
import { runRecorded, fork, change } from '@cycgraph/orchestrator';

const base = await runRecorded(workflow, { goal: 'Explain how vaccines work' });

const terse = await fork(base, {
  at: { beforeNode: 'write' },
  change: change.prompt('write', 'Rewrite as exactly three bullet points.'),
});

console.log(terse.explain());
```

The research node never runs again. Its output is replayed out of the event log, so only the writer executes:

```
fork 8f3a2c… of 41d0be… at seq 6 (before 'write' execution 1, iteration 1)
  change    prompt of 'write'
  status    completed
  path      research → write
  cost      $0.0021 incurred, +412 tokens
  memory    ~draft (+180B)
```

## Why this works

The engine keeps a gap-validated, append-only [event log](/docs/concepts/persistence/) of every state transition so a crashed run can be rebuilt by folding those events back through the same reducers that produced them. That machinery exists for crash recovery. Point it at a question instead of a crash and you get counterfactuals.

The replayed part is free. It makes no model calls, because the stored actions already carry what the agents said. Forking a twenty-minute run to retry the node that broke costs the price of that one node.

## Recording a forkable run

A `run` returns final memory and nothing else, and wires no event log, so a run made with it cannot be forked afterwards. `runRecorded` is the same execution with the handles kept:

```typescript
const base = await runRecorded(workflow, { goal: '…' });
```

It wires an event log, turns auto-compaction off so the whole log stays addressable, and saves the graph so the run row resolves back to it. Pass the result straight to `fork`; it reads the run id, the log, the provider, and the run-scoped agent registry off it.

That registry matters most. The `graph` builds it per run from inline `agent` definitions, so it exists nowhere else, and a fork that cannot reach it cannot resolve the graph's agents.

## Choosing where to fork

| Form | Meaning |
| --- | --- |
| `'start'` | Re-run the whole graph under the change |
| `'failure'` | Before the node that failed. The default on a failed run |
| `{ beforeNode, occurrence }` | The node re-executes. `occurrence` matters in loops |
| `{ afterNode }` | The node's output is kept; only what follows changes |
| `{ beforeIteration }` | A loop boundary |
| `{ sequence }` | A raw event sequence, the canonical stored form |
| `{ beforeFirstWriteOf }` | Before the node that first wrote a memory key |
| `{ beforeFirstReadOf }` | Before the node whose retrieval injected a given fact |
| `{ where }` | A predicate over the replayed state |
| `{ version }` | A persisted state snapshot, with `source: 'snapshot'` |

`beforeNode` and `afterNode` ask different questions and both come up. `beforeNode` asks whether a different writer would have done better; `afterNode` asks whether, given this draft, a different reviewer would have caught the problem.

Every form resolves to a single integer, and only one kind of position is valid: the boundary immediately before a node starts. Anywhere else, state holds an action whose usage accounting has not landed, or a node that has emitted nothing yet — states the run never persisted. An address landing mid-execution is rejected naming the node it would have split.

`forkPoints(events)` lists what a particular run makes addressable.

## Changes

| Call | Effect |
| --- | --- |
| `change.model(target, model)` | Swap the model |
| `change.prompt(target, text)` | Replace the system prompt |
| `change.temperature(target, t)` | Resample at a different temperature |
| `change.memory({ set, delete })` | Patch the forked state before the tail runs |
| `change.config(nodeId, patch)` | Patch node config, re-validated at node and graph level |
| `change.route(from, to)` | Force a routing decision |
| `change.output(nodeId, memory)` | Substitute what a node produces |
| `change.tool(nodeId, result)` | Substitute a tool result |
| `change.humanResponse(decision)` | Answer approval gates instead of pausing |

For a node carrying several agents, add a dotted role: `change.model('review.judge', …)`, `change.model('vote.voters[2]', …)`. A node that drives no agent, such as a tool, router, or approval node, takes `change.memory` or `change.output` instead, and says so if you ask it for a model.

An agent change is scoped to the node that names it, so overriding one node's model leaves other nodes sharing that agent untouched.

A change can also be a function of the resolved fork point, which is how you avoid typing a name you would have to look up first:

```typescript
await fork(base, {
  at: 'failure',
  change: (at) => change.model(at.node!, 'claude-opus-5'),
});
```

## Combining versus isolating

You can `fork` with several changes to see if the bundle works. The `forkEach` tells you which change mattered. They answer different questions.

```typescript
// One fork, three changes. "Did my fix work?"
await fork(base, { at: 'failure', change: [a, b, c] });

// Four forks off one prefix. "Which of these moved the needle?"
const sweep = await forkEach(base, {
  at: 'failure',
  variants: { stronger: a, stricter: b, guided: c, all: [a, b, c] },
});
```

Every variant in a sweep forks the same run at the same point, so the only thing separating them is the change. That pairing is why a sweep beats four unrelated runs. A combined fork's diff cannot attribute its delta among its changes, and says so.

`estimateSweep()` predicts the spend without running anything, and reports a change that will not resolve before any variant has cost money.

## Reading the result

`f.diff` is structured; `f.explain()` renders it.

- **`path.aligned`** — the two runs' node paths aligned by longest common subsequence, so a substituted node reads as `write→write@fork` rather than the whole tail looking rewritten.
- **`memory`** — per key: added, removed or changed, with a byte delta and whether its taint status moved.
- **`cost.incurredUsd`** — what the tail actually spent. The prefix's cost is inherited into the variant's totals for fidelity but excluded here, because a fork that replays two nodes did not pay for them again.
- **`suppressedEffects`** — what the guard held back.

A diff says what changed, not whether it was worth it. For that, check assertions against both runs, or supply a score — see [Eval Assertions](/docs/concepts/eval-assertions/).

## Side effects

A forked tail re-runs real nodes. By default a `tool`, `a2a`, or `subgraph` node is served its recorded result when the base run executed it with the same inputs, and **blocked** otherwise: a counterfactual that re-sends an email is worse than one that stops.

```typescript
policy: { sideEffects: 'block' }              // never execute one
policy: { sideEffects: { allow: ['fetch'] } } // this node, for real
```

Reflection nodes get their own treatment. The injected `memoryWriter` is wrapped so intended writes are captured and discarded — without that, a fork measuring whether a lesson helped would write new lessons into the pool it is measuring.

Blocking is a normal outcome, not a failure. Change a router's input so it takes a branch the base run never took, and the guard stops at the first node on that branch, because there is no recorded result for it and no safe way to invent one.

## Memoization

`policy: { memoize: true }` serves a tail node its recorded output when its inputs are unchanged. On a wide graph that skips the branches a change could not reach: alter one branch of a diamond and the independent branch is replayed while the changed branch and the join re-execute.

It is off by default, because "the tail runs live" is what a fork promises. Two reasons to turn it on: it removes resampling noise from the comparison, since a node the change could never affect can no longer drift; and it makes sweeps affordable, because the unaffected suffix is paid for once instead of once per variant.

The fingerprint hashes the node, its config, its effective read slice, and every agent it drives. A fingerprint seen twice in one run is discarded rather than reused — a node handed identical inputs that produced two different outputs is one this cannot predict, and a fix-loop depends on exactly that.

## Observability

A fork runs through the ordinary engine, so it is traced, logged, and counted like any other run — with three additions that keep it distinguishable from the traffic it is imitating.

**Traces.** The tail gets a `replay.fork` span carrying `fork.run_id`, `fork.base_run_id`, `fork.sequence_id`, `fork.node_id`, `fork.changes`, and `fork.base_trace_id` when the caller knows it. The runner's own `workflow.run` span and every `node.execute.*` below it nest under that, so a fork reads as a fork in a trace viewer rather than as an unexplained second run of the same graph.

**Metrics.** `GraphRunnerOptions.runKind` labels `mcai_workflows_*` as `primary`, `subgraph`, or `counterfactual`, and `fork()` sets it. Without the label a sweep of twelve variants reads as twelve workflows. Cost is separable through `run_kind` on the run row; this is the same separation for counters, which have no row to join against.

**Logs.** Structured logs flow to whatever `runner.logger` points at, plus a `replay.fork.fork_started` line carrying the base run, the sequence, and the node.

`fork()` accepts a `runId` so a caller can open a recorder, log sink, or anything else keyed on the run *before* the tail starts producing into it. Minting the id inside the fork would force those to open afterwards, and they would capture nothing.

## What is forkable

Forking replays a log, so the run must have one. Three limits:

**Compaction.** Auto-compaction deletes events behind the newest checkpoint at 1000 events by default, which puts early fork points out of reach on long runs. `runRecorded()` turns it off for this reason. For a production run that was compacted, `source: 'snapshot'` forks from a persisted state snapshot addressed by `{ version }`, at the cost of precision: a snapshot can sit inside a node's execution, so that node re-runs.

**Retention.** Archived runs lose their events.

**Replay version.** A run recorded under different reducer semantics is refused rather than warned about. Recovery only warns, because an approximate state still beats losing the run; a fork exists to compare two states, and a version skew makes them incomparable.

## Persistence

A fork is a first-class run. `workflow_runs` carries `run_kind` (`primary`, `subgraph`, or `counterfactual`), `parent_run_id`, `fork_sequence_id`, the serialized `fork_mutations`, and `fork_group_id` tying a sweep together.

`run_kind` exists because `parent_run_id` alone is ambiguous — subgraph children have used it since before forking existed. Analytics and retention filter on it so counterfactual spend stays out of production numbers unless asked for. `usage_records` joins to `workflow_runs`, so excluding fork spend is that join rather than a separate column.

## Trying it

The [`counterfactual-replay` example](https://github.com/wmcmahan/cycgraph/tree/main/packages/orchestrator/examples/counterfactual-replay) records a run, forks it, and sweeps three variants against the same recording. It runs against a local Ollama model with no API key.

The playground exposes forking as a verb over any recorded run:

```bash
npm run play -- fork <scenario> --at <node> --prompt <node>=<text>
npm run play -- fork-check          # null-fork every point of every scenario
npm run play -- serve               # dashboard: pick a point, change, diff
```

`fork-check` asserts the fidelity invariant across the whole scenario corpus: a fork that changes nothing must reproduce the original exactly. It costs nothing to run, because a null fork memoizes every tail node and makes no model calls.

## API

### `fork(base, options)`

Replay a run to a point, apply changes, execute the tail. Resolves with the variant's final state, a structured diff, and what the guard held back.

```typescript
fork(base: string | ForkableRun, options: ForkOptions): Promise<ForkResult>
```

`base` is a run id, or the `runRecorded()` result — passing the result lets `fork` read the run id, event log, persistence provider, and run-scoped agent registry off it instead of restating all four.

### `forkEach(base, options)`

One fork per named variant, all from the same run at the same point. Resolves with a per-variant result, a shared `forkGroupId`, and total incurred spend.

```typescript
forkEach(base: string | ForkableRun, options: ForkEachOptions): Promise<ForkEachResult>
```

A variant that throws is recorded on its own entry rather than aborting the sweep, since the others have already been paid for. Concurrency defaults to 4, applied across the whole sweep rather than per variant.

### `estimateSweep(base, options)`

Resolve every variant as a dry run and predict the spend, without executing anything. Raises on a change that will not resolve, so a bad target surfaces before the first variant costs money.

```typescript
estimateSweep(
  base: string | ForkableRun,
  options: ForkEachOptions,
): Promise<{ costUsd: number; lines: string[] }>
```

### `change`

Builders for the declarative change spec. Each returns a plain serializable object, so a fork is reproducible from its recorded `fork_mutations`.

```typescript
change.model(target: string, model: string, opts?: { provider?: string }): ModelChange
change.prompt(target: string, systemPrompt: string): PromptChange
change.temperature(target: string, temperature: number): TemperatureChange
change.memory(patch: { set?: Record<string, unknown>; delete?: string[] }): MemoryChange
change.config(nodeId: string, patch: Record<string, unknown>): NodeConfigChange
change.route(from: string, to: string, opts?: { once?: boolean }): RouteChange
change.output(nodeId: string, memory: Record<string, unknown>): OutputChange
change.tool(nodeId: string, result: unknown): ToolChange
change.humanResponse(
  decision: 'approved' | 'rejected' | 'edited',
  opts?: { data?: unknown; memoryUpdates?: Record<string, unknown> },
): HumanResponseChange
```

Two changes writing the same thing are refused at fork time rather than resolved by order, because in a sweep matrix that is nearly always a copy-paste error.

### `forkPoints(events)`

Every position a recorded run exposes, with the occurrence index that distinguishes a node's second execution from its first.

```typescript
forkPoints(events: readonly WorkflowEvent[]): ForkPointSummary[]
```

### `diffRuns(base, variant, options?)`

Compare two final states. Pure and synchronous.

```typescript
diffRuns(base: WorkflowState, variant: WorkflowState, options?: DiffOptions): RunDiff
```

`fork()` computes this eagerly and returns it as `result.diff`, so calling it directly is for comparing runs that were not forked from each other.

### `formatRunDiff(diff, header?)`

Render a diff as the block `explain()` prints.

```typescript
formatRunDiff(diff: RunDiff, header?: string): string
```

### `runRecorded(graph, input, options?)`

Run a graph and keep everything needed to refer back to it. Same execution as [`run()`](/docs/guides/first-workflow/), three differences in what it leaves behind: an event log is wired, auto-compaction is off, and the graph is saved before execution.

```typescript
runRecorded(
  graph: Graph,
  input: RunInput | WorkflowState,
  options?: RunOptions,
): Promise<RecordedRun>
```

### `canonicalJson` / `canonicalEquals`

Serialize or compare with object keys sorted and `undefined`-valued keys treated as absent. Exported because anything comparing state across a durable round-trip needs it: `jsonb` does not preserve key order, so a plain `JSON.stringify` reports two identical states as different.

```typescript
canonicalJson(value: unknown): string
canonicalEquals(a: unknown, b: unknown): boolean
```

## Interfaces

### ForkOptions

| Field | Type | Description |
|-------|------|-------------|
| `at` | `ForkPoint?` | Where to diverge. Defaults to `'failure'` on a failed base run; raises on a completed one. |
| `change` | `ChangeInput?` | One change, several, or a function of the resolved fork point. |
| `eventLog` | `EventLogWriter?` | The base run's log. Optional only for a snapshot fork. |
| `source` | `'events' \| 'snapshot' \| 'auto'?` | Which substrate to read from. `'auto'` prefers events, falling back to snapshots past the compaction boundary. |
| `graph` | `Graph?` | The base run's graph. Resolved through `persistence` when absent. |
| `persistence` | `PersistenceProvider?` | Resolves the graph, and receives the variant's run row, lineage, and snapshots. |
| `registry` | `AgentRegistry?` | Where the tail's agents come from. |
| `runId` | `string?` | Names the variant, so a recorder or log sink can open before the tail produces into it. |
| `variantEventLog` | `EventLogWriter?` | Log the variant records into. Defaults to the base run's log when `persistence` is supplied, so a persisted fork is crash-recoverable; otherwise a fresh in-memory log. |
| `policy` | `{ sideEffects?, memoize? }?` | Side-effect handling and memoization. See below. |
| `hitl` | `(question) => Promise<HumanResponse>?` | A reviewer who is present, answering gates as they arise. |
| `runner` | `GraphRunnerOptions?` | Extra options for the tail's runner. |
| `forkGroupId` | `string?` | Groups this variant with the rest of a sweep. |
| `baseTraceId` | `string?` | Trace the base was recorded under, for the fork span to point at. |
| `dryRun` | `boolean?` | Resolve and report without executing. |
| `ignoreBudget` | `boolean?` | Proceed when the inherited budget cannot cover the estimated tail. |

### ForkPoint

```typescript
type ForkPoint =
  | 'start'
  | 'failure'
  | { sequence: number }
  | { version: number }
  | { beforeNode: string; occurrence?: number | 'last' }
  | { afterNode: string; occurrence?: number | 'last' }
  | { beforeIteration: number }
  | { beforeHumanInput: true }
  | { beforeFirstWriteOf: string }
  | { beforeFirstReadOf: string }
  | { where: (ctx: ReplayStopContext) => boolean };
```

An address that does not resolve reports the candidates: an unknown node lists the nodes that ran, an out-of-range occurrence says how many times the node executed, and a sequence behind the compaction boundary reports the earliest forkable point.

### SideEffectPolicy

```typescript
type SideEffectPolicy = 'replay' | 'block' | { allow: string[] | true };
```

`'replay'` is the default: serve the recorded result when the base run executed that node with the same inputs, and block otherwise. Applies to `tool`, `a2a`, and `subgraph` nodes.

### ForkResult

| Field | Type | Description |
|-------|------|-------------|
| `runId` | `string` | The variant's run id. |
| `baseRunId` | `string` | The run it forked. |
| `forkSequenceId` | `number` | Sequence the variant began diverging at. |
| `forkNodeId` | `string?` | Node the tail started with. |
| `state` | `WorkflowState \| null` | The variant's final state. `null` for a dry run. |
| `baseState` | `WorkflowState` | The base run's final state. |
| `prefixState` | `WorkflowState` | Reconstructed prefix, before changes were applied. |
| `diff` | `RunDiff \| null` | Comparison against the base run. |
| `changes` | `Change[]` | Changes as applied, in wire form. |
| `estimate` | `TailEstimate` | What the tail was predicted to cost, before it ran. |
| `incurredCostUsd` | `number` | What the tail actually spent, over the prefix it inherited. |
| `suppressedEffects` | `SuppressedEffect[]` | Side effects the guard held back. |
| `memoHits` | `MemoHit[]` | Tail nodes served from the recording. |
| `eventLog` | `EventLogWriter` | The variant's log. |
| `explain()` | `() => string` | Human-readable summary. |

### RunDiff

| Field | Type | Description |
|-------|------|-------------|
| `divergence` | `{ index, base?, variant? } \| null` | First position where the paths differ. |
| `path.aligned` | `AlignedStep[]` | Both paths aligned by longest common subsequence, with substitutions coalesced. |
| `path.inserted` / `.skipped` | `string[]` | Nodes the variant added or dropped. |
| `memory` | `Record<string, MemoryDelta>` | Per key: `added` / `removed` / `changed`, byte delta, whether taint moved. |
| `terminal` | `{ base, variant, iterationsDelta, wallClockDeltaMs }` | Status and elapsed comparison. |
| `cost` | `{ tokensDelta, usdDelta, incurredUsd, perNode }` | Spend, separating what the tail incurred from what the prefix carried. |
| `suppressedEffects` | `SuppressedEffect[]` | What the guard held back. |
| `score` | `{ base, variant, delta }?` | Present when the caller supplied scores. |

Field names are camelCase: a `RunDiff` is a result object read in TypeScript, not something persisted or replayed, so it follows the TS convention rather than the snake_case rule governing schemas and wire payloads.

### RecordedRun

| Field | Type | Description |
|-------|------|-------------|
| `runId` | `string` | The handle every after-the-fact API takes. |
| `memory` | `Record<string, unknown>` | Final memory, identical to what `run()` returns. |
| `state` | `WorkflowState` | Final state, for status, cost totals, per-node breakdowns. |
| `eventLog` | `EventLogWriter` | The log the run was recorded into. |
| `persistence` | `PersistenceProvider` | Holds the graph and run rows. |
| `registry` | `AgentRegistry?` | The run-scoped registry holding the graph's inline `agent()` definitions. Absent when the graph references pre-registered agents by id. |

## Next steps

- [Persistence](/docs/concepts/persistence/): the event log a fork replays, and the lineage columns it writes
- [Graph Runner](/docs/concepts/graph-runner/): the execution loop a forked tail runs through
- [Middleware](/docs/concepts/middleware/): the `beforeNodeExecute` seam that serves recorded actions
- [Eval Assertions](/docs/concepts/eval-assertions/): turning "what changed" into "was it better"
