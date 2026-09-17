---
"@cycgraph/orchestrator": patch
---

`RUNTIME_CONFIG_ENV_VARS` on the internal subpath: the list of environment variables the runtime configuration reads, derived from the same table the loader uses. Harnesses that spawn an engine-hosting child with a scrubbed environment strip these so the child runs a default engine instead of inheriting the parent's tuning.
