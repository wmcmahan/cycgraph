---
"@cycgraph/tools": patch
---

`diagnosticsTool` accepts a `name` option so a graph can carry more than one caller-fixed probe (a typecheck and a changed-files check, say) without tool-name collisions.
