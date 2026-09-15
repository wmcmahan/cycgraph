---
"@cycgraph/a2a": patch
"@cycgraph/orchestrator": patch
"@cycgraph/tools": patch
---

Agent Card endpoint URLs are now re-checked at connect time: each endpoint host is resolved and refused when any address is private/loopback/link-local, so a public-looking name backed by a private DNS record no longer reaches internal services, and a lookup that fails or times out fails closed. The resolve-and-reject policy is shared with the MCP transport and web-tool guards, which changes two user-visible details: blocked web fetches now report `resolves to a private/loopback address (<addresses>)` and list every offending address, and the MCP guard logs lookup failures as `mcp_ssrf_lookup_failed` while `mcp_ssrf_blocked_resolved_ip` keeps its `blocked` addresses field.
