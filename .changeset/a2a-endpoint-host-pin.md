---
"@cycgraph/a2a": patch
"@cycgraph/orchestrator": minor
---

Pin the RPC endpoints an Agent Card may name, and every redirect hop a request follows, to the host of the registry's `agent_card_url` plus the optional new `allowed_endpoint_hosts` list on an A2A server entry. A card that names an unrelated public host, or a remote that answers with `Location:` pointing at one, is now refused instead of receiving the server's bearer token or custom auth header.
