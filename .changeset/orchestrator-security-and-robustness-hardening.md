---
"@cycgraph/orchestrator": minor
---

Security and robustness hardening across the engine. Several fixes restore guarantees that were advertised but not actually enforced.

**Taint tracking.**
- Fan-out executors (`map` / `voting` / `evolution`) now re-surface worker taint onto their aggregate output keys (`${node}_results` / `_consensus` / `_winner`). Previously tainted MCP output from a worker branch landed in the parent state **unmarked**, so downstream routing/gating couldn't see it — the taint control silently failed for every fan-out workflow. New `aggregateParallelTaint` helper mirrors the subgraph executor's child→parent carry-back.
- `graph.strict_taint` is now actually enforced: it is threaded from the runner into `getNextNode` → `evaluateCondition`, so a `true` value rejects edge conditions that reference tainted memory keys. It was previously defined and documented but never wired in (a no-op). The tainted-key match is also boundary-aware now, so a short tainted key (e.g. `e`) no longer matches every expression.

**Budget & recovery.**
- `total_tokens_used` is no longer double-counted for `map`/`voting`/`evolution` nodes — the reducer stopped adding tokens that the runner's `_track_tokens` already accounts for. The token budget was previously tripping at half the real budget for fan-out-heavy graphs.
- Crash recovery from the event log (no checkpoint) now restores the run's limits (`max_token_budget`, `max_iterations`, `max_execution_time_ms`, `goal`, `constraints`) from a new `config` payload on the `workflow_started` event, instead of silently resuming with defaults (no budget, `max_iterations` 50). Replay-safe and additive; older logs fall back to the previous defaults.

**Hardening.**
- SSRF guard on MCP transport URLs now canonicalizes the host before the private-range check, so decimal (`http://2130706433/`), hex, octal, short-form (`127.1`), and IPv4-mapped-IPv6 encodings of loopback/metadata addresses can no longer bypass it.
- MCP tool results are capped at 10 MB; an oversized (or unserializable) result is replaced with a small error marker instead of being held in memory, fed into the LLM context, and copied into the event log (worker OOM protection).
- Graph schema numerics/arrays are bounded: `FailurePolicy.max_retries` is now `int [0, 10]` (each retry is an LLM call — an unbounded value was the sharpest cost-exhaustion lever), backoffs / circuit-breaker thresholds / timeouts are capped, and `nodes`/`edges`/`read_keys`/`write_keys`/`max_handoffs` have upper bounds. **Note:** graphs that previously set `max_retries` above 10 or to a non-integer will now fail validation.
- Cost estimation coerces token counts to finite, non-negative values, so a `NaN` from malformed provider usage can no longer produce a `NaN` cost that permanently disables the USD budget.
- ReDoS mitigation on the runtime verifier's `matches` op (and the eval `regex` assertion): the pattern length is bounded, nested-quantifier patterns (`(a+)+` …) are refused, and the matched value is length-capped.
- MCP tool resolution warns when a source omits `tool_names` (granting every server tool) and uses `hasOwnProperty` instead of `in` for the allowlist check (so `tool_names: ["toString"]` can't match a prototype member).
- The JSON-Schema→Zod converter for MCP tool manifests bounds recursion depth (32) and per-object property count (1000).
- The graph validator now warns on `write_keys: ['*']`, symmetric to the existing wildcard-read warning.
