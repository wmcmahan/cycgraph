---
"@cycgraph/orchestrator": minor
---

Counterfactual replay: fork a recorded run, change one thing, re-run only what the change could affect.

The engine already keeps a gap-validated event log so a crashed run can be rebuilt by folding its events back through the reducers that produced them. Pointed at a question instead of a crash, that same machinery answers what-if — and the replayed part is free, because the stored actions already carry what the agents said.

```ts
const base = await runRecorded(workflow, { goal: 'Explain how vaccines work' });

const terse = await fork(base, {
  at: { beforeNode: 'write' },
  change: change.prompt('write', 'Rewrite as exactly three bullet points.'),
});

console.log(terse.explain());
```

The research node never runs again; only the writer executes.

`runRecorded()` is `run()` with the handles kept — `{ runId, memory, state, eventLog, persistence, registry }`. It wires an event log, disables auto-compaction so the whole log stays addressable, and saves the graph so the run row resolves back to it. `run()` returns memory alone and records nothing, so a run made with it cannot be forked afterwards.

Ten ways to address a fork point (`'failure'`, `{ beforeNode, occurrence }`, `{ afterNode }`, `{ beforeFirstReadOf }`, a raw sequence, a state snapshot, …), all resolving to the one position that is valid: the boundary immediately before a node starts. Nine kinds of change through one `change.*` builder, targeting **node ids** rather than agent ids, since agent ids are generated UUIDs nobody holds.

`forkEach()` runs one fork per named variant off the same prefix, so the only thing separating them is the change — that pairing is why a sweep beats N unrelated runs. `estimateSweep()` predicts the spend first.

Two guarantees worth knowing:

- **Side effects fail closed.** A `tool`, `a2a`, or `subgraph` node in the tail is served its recorded result when its inputs are unchanged, and blocked otherwise. Reflection nodes get a capturing memory writer, so a fork measuring whether a lesson helped cannot write lessons into the pool it is measuring.
- **A persisted fork is durably recoverable.** With `persistence` supplied, the variant's events default into the base run's event log, its row and lineage are written before its first event so relational foreign keys hold, and a tail that throws marks the row `failed` rather than leaving it `running` forever.
- **A null fork reproduces its base exactly.** With `policy: { memoize: true }` and no change, every tail node is served from the recording and no model is called — which makes the fidelity invariant free to check.

Also: `GraphRunnerOptions.runKind` labels `mcai_workflows_*` so counterfactual traffic is separable from production traffic, and `fork()` emits a `replay.fork` span carrying the base run, sequence, node, and base trace id.
