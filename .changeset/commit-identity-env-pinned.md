---
"@cycgraph/tools": patch
---

`commit` now pins the commit identity through `GIT_AUTHOR_*`/`GIT_COMMITTER_*` env as well as `-c user.*`: ambient git identity variables (as CI sets for the workflow's own commits) override `-c`, which made commits land under the environment's identity instead of the configured one.
