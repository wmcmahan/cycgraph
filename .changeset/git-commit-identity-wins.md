---
"@cycgraph/tools": patch
---

`commit` now sets the author and committer through the environment as well as `-c user.*`, so a delivery commit carries the configured identity even when the surrounding CI runner exports `GIT_AUTHOR_NAME`/`GIT_AUTHOR_EMAIL`.
