---
"@cycgraph/orchestrator": patch
---

Anthropic prompt caching now actually hits. The previous release
advanced a single cache breakpoint to the always-new end of each step's
transcript — a boundary no earlier request had written, so every step
missed, paid the cache-write premium on the whole prefix, and read
nothing. Breakpoints now mark the ends of the last three messages, so
each request still carries the previous request's boundary (a hit) and
writes only the delta. Agent executions also log `token_usage` with
`cached_input_tokens`, so whether the cache is hitting is visible in
the run log rather than inferred from the bill.
