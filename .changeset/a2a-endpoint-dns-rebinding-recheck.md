---
"@cycgraph/a2a": patch
---

The Agent Card endpoint SSRF guard now re-checks DNS-resolved addresses at connect time, so a card advertising a public-looking hostname that resolves to loopback, link-local, cloud-metadata, or RFC1918 addresses is refused instead of being connected to. Lookups fail closed (5s budget) and the `CYCGRAPH_ALLOW_PRIVATE_A2A_URLS=true` development opt-out still skips the whole guard.
