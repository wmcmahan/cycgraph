---
"@cycgraph/evals": patch
---

Insights and sweeps understand namespaced child nodes: profile and outlier denominators count top-level nodes only (a child's time is already inside its container's), child boundaries appear as first-class profile rows, and temperature sweeps recognize a `/`-namespaced agent or supervisor row as agent-backed without a parent-graph lookup.
