---
"@cycgraph/context-engine": patch
---

The incremental pipeline no longer throws on the second and later turns when a per-segment stage removes a segment. Removed segments are left out of the ordered output, and an unchanged removed segment is now served from cache instead of being compressed again.
