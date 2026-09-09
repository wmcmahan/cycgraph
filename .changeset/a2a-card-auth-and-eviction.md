---
"@cycgraph/a2a": patch
---

Agent Card resolution now carries the same per-server auth headers as every other request, so registries that gate their card endpoint behind the entry's credential resolve instead of failing with a generic transport error. A failed card resolution is also evicted from the per-URL cache, so a transient fault at boot no longer poisons that server for the life of the client.
