---
"@cycgraph/studio": patch
---

`applyProposal` now reports the real fixture flag instead of always `false`: it accepts the resolved repository from `resolveApplyRepo` (a bare path still means the real repo) and carries `fixture` into its outcome. The unattended `loop --autonomy apply` path now warns again when the committed branch lives in a throwaway fixture clone with no remote.
