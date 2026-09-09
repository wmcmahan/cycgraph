---
"@cycgraph/context-engine": patch
---

The incremental pipeline re-runs cross-segment stages when a segment is deleted. Previously a shrunk segment set with byte-identical survivors reused the previous turn's cross-phase output — stale for the new set, since dedup and budget allocation compute over all segments together.
