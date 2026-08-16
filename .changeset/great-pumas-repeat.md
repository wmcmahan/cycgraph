---
"@cycgraph/orchestrator": patch
---

The queue-depth gauge has a source, and stopping a worker no longer waits out a poll interval.

`setQueueDepthProvider` had no caller anywhere in the engine, so `workflow.queue.depth` was declared and never observed. `WorkflowWorker` now registers its own queue on start and clears it on stop, which is the only component holding a queue that outlives a single run.

Wiring it surfaced a separate defect: `stop()` awaits the poll loop, and the loop spends nearly all its time inside a `sleep(pollIntervalMs)` that clearing the running flag did not interrupt. Shutdown therefore took up to a full poll interval. At the 1s default this was invisible, but a worker configured to poll every 30s would outlast a typical SIGTERM grace period and be killed with jobs still claimed, leaving them to visibility-timeout reclaim rather than a clean handover. The sleep is now interruptible and `stop()` returns immediately.
