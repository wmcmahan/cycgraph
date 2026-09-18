---
"@cycgraph/a2a": patch
---

Revalidate every redirect hop on Agent Card and JSON-RPC requests. Redirects are now followed manually and each hop is re-checked against the scheme, literal-host, and DNS rules (capped at 5 hops), so a public host can no longer 302 a request — bearer token included — into private infrastructure.
