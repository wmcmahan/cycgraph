---
"@cycgraph/studio": patch
---

Fix the Logs page dropping rows when runs overlap in time: the cross-run scan now compares each run's recorded end against the page's true oldest kept row instead of the last row appended before sorting, so concurrent runs no longer cut the merged stream short.
