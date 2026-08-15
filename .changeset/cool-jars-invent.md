---
"@cycgraph/orchestrator": minor
---

Fix retry, streaming, and fan-out behaviours that only surface at non-default settings.

- `failure_policy.max_retries: 0` no longer skips the node entirely. The value
  bounds attempts and is floored at one, so "do not retry" means the node runs
  once rather than never.
- `stream()` now establishes the run context and a `workflow.run` root span for
  each step of the loop. Runner-level log lines reach a configured `logger`
  sink instead of the process streams, and node spans nest under one trace
  rather than each becoming its own root.
- `shutdownTracing()` is exported. `initTracing` flushed only on SIGTERM and
  SIGINT, so any process that ran and exited discarded its buffered spans.
- `SubgraphInterfaceError`, `A2AInterfaceError`, and `NodeConfigError` carry
  `retryable = false`. None can succeed on a retry, so they fail immediately
  instead of consuming the node's attempt budget. This matters most where
  nesting multiplies it: a composition that trips the subgraph depth cap raises
  a config error at the bottom of the chain, and a retryable error there was
  re-attempted by every ancestor — turning a bounded refusal into exponentially
  many descents, which at the 32-level cap does not terminate in practice.
- `node:failed` reports the attempt the failure actually happened on. It
  previously reported the configured retry budget, so a non-retryable error
  that failed on the first attempt was indistinguishable from one that
  exhausted every retry.
- New `workflow:cancelled` terminal stream event. A run that stops on purpose —
  cancelled, or declined at a gate with nowhere to route — previously ended the
  stream with no terminal event at all.
- Failures that leave the execution loop by breaking rather than raising — the
  iteration cap, an unresolvable current node, a dead end on the replay path —
  now yield `workflow:failed` and emit the matching runner event. They
  previously set the status and ended the stream silently, so a streaming
  consumer could not tell them from a run that vanished. Whether `run()` throws
  for those paths is unchanged.
- A human decision arriving after an approval gate's deadline is refused, and
  the run resumes into its timeout. The expiry check was previously unreachable
  because applying the response cleared the `waiting` status it tests, and the
  sequence-id advance on resume now happens before either branch so the timeout
  path cannot collide with the existing event log.
- Child runs started by a `subgraph` node inherit the parent's `logger`. Every
  other injected port was already threaded to the child; a host with a
  configured sink still lost every nested run's lines to the process streams.
- Cancelling a run stops parallel fan-out from claiming more work. The pool's
  claim loop checked only for a failed task under `fail_fast`, never the
  workflow's abort signal, so a cancelled `map`, `voting`, or `evolution` node
  ran its whole batch out — the most expensive node types ignoring cancellation
  entirely. Tasks with no per-task timeout now also receive the signal, so
  in-flight work can observe it.
- A `tool` worker in a map fan-out receives its item. The per-item context
  reached an agent worker's prompt but not a tool worker's arguments, so every
  tool worker in a fan-out ran identical, item-blind work.
- `PersistenceProvider.saveWorkflowRun` documents that a durable run must
  persist its graph and run rows before executing, which relational
  implementations require and in-memory ones do not. New `MissingRunRecordError`
  for adapters to raise when that ordering was skipped.
- Every `logger.error` call in the workflow worker passes the thrown error
  where the signature expects it. All five passed a context object instead, so
  the logger stringified it to `[object Object]`, reported `UnknownError`, and
  discarded the job id, run id, and cause. The worker runs unattended, which
  makes its logs the ones most worth reading.
- The event log's halt error carries what actually rejected the write, in both
  its message and its `cause`. It previously reported only the flush count, so
  the actionable part was left in the log for someone to correlate.
