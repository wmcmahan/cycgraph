---
"@cycgraph/a2a": patch
---

Bound each shared Agent Card resolution with its own 30s timeout and evict the cache entry when it fires. A remote that accepted the connection and never answered previously left a permanently pending card promise cached for that agent, failing every later call to it until the process restarted.
