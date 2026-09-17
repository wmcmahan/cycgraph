---
"@cycgraph/a2a": patch
---

The Agent Card URL is now DNS re-checked at connect time before the card request leaves, matching the MCP transport and web-fetch guards: a registry entry whose host resolved publicly when it was written but privately when it is called (DNS rebinding) no longer reaches loopback, internal, or cloud-metadata addresses. Lookup failure fails closed, and `CYCGRAPH_ALLOW_PRIVATE_A2A_URLS=true` still skips both A2A guards for local development.
