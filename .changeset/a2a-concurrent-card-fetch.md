---
"@cycgraph/a2a": patch
---

Agent Card resolution is now claimed in the cache before the SSRF/DNS check runs, so concurrent first calls for the same agent card URL and header set share a single card fetch instead of each issuing their own. Fan-out patterns (map, voting, parallel branches) against one agent no longer hit the remote's card endpoint once per node execution.
