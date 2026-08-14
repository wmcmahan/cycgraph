---
"@cycgraph/orchestrator": minor
---

Logging is quiet by default and can be routed to your own transport.

**The engine no longer writes to stdout unless asked.** The default level moves
from `info` to `error`, so a normal run prints nothing and a failing one still
says why. A library should not write to a host's stdout uninvited, which is the
same reason tracing no-ops without an OTLP endpoint and metrics stay off without
`METRICS_ENABLED`. Logging was the only observability channel that was on by
default and could not be turned off.

If you were relying on the JSON-per-line output, set `LOG_LEVEL=info` to restore
it. A new `silent` level suppresses errors too.

**`LOG_LEVEL` now works regardless of import order.** Every logger in the engine
is a module-level constant, and the level used to be read in the constructor,
which froze it before an application that loads its environment with dotenv had
a chance to set it. It is now resolved on first use and cached once per process.

**A `logger` option on `GraphRunnerOptions` receives entries instead of the
process streams:**

```typescript
new GraphRunner(graph, state, {
  logger: (entry) => pino[entry.level](entry.context, entry.event),
});
```

It is a function rather than an object with `.info()` / `.warn()` methods,
because the engine has already resolved the level and built the entry by the
time it is called. `LogEntry`, `LogContext`, `LogSink`, and `RunContext` are
exported for adapters.

The sink is per run, carried on the same async-local context that already
propagates `run_id`, so concurrent runs can send to different destinations
without interfering. It sits after level filtering, so `LOG_LEVEL` governs it
exactly as it governs stdout. A throwing sink cannot fail a workflow: the
failure is reported once as `logger.sink_failed` and execution continues. A
returned promise is not awaited, since logging sits in the hot path of every
node — sinks needing durability should buffer and flush on their own schedule.

Entries emitted outside a run, such as module load or registry calls before
`run()`, have no run context and still go to the process streams. A sink is not
a complete capture of everything the package can emit.
