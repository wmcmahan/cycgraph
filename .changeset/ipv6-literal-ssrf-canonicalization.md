---
"@cycgraph/orchestrator": patch
---

The SSRF host guard now canonicalizes IPv6 literals (expanding `::`, dropping zone ids, folding IPv4-mapped/translated/compatible and NAT64 forms) before range-checking, and fails closed on any IPv6 literal it cannot canonicalize. Non-canonical spellings of loopback such as `[0:0:0:0:0:0:0:1]` or `[0:0:0:0:0:ffff:7f00:1]` are no longer accepted as public hosts by MCP transport URLs, A2A agent card URLs, or web tool fetches.
