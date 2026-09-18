---
"@cycgraph/memory": patch
---

`checkFactAdmission` now pages through every matching fact instead of comparing the candidate against a single capped fetch, so duplicates and evicted lessons stored past the cap are no longer admitted in stores with more than 1000 tagged facts. The `limit` option is now the page size rather than a hard cap on the scan.
