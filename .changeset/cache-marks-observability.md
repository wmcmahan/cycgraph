---
"@cycgraph/orchestrator": patch
---

The per-execution `token_usage` log line now carries `cache_marks`: one count per request of the cache breakpoints that request actually carried. A zero-cache run's log can now distinguish "marks were never sent" from "the provider returned nothing for them"; the field is absent entirely when the caching prepare-step was not active.
