---
"@cycgraph/a2a": patch
---

The endpoints a resolved Agent Card offers are now SSRF-guarded before any transport is built: the registry validates the card URL, but the card's returned RPC endpoints come from the remote, and a compromised agent could point the transport at loopback or cloud-metadata hosts. Honors the same `CYCGRAPH_ALLOW_PRIVATE_A2A_URLS=true` development opt-out as the card-url guard.
