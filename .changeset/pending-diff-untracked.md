---
"@cycgraph/tools": patch
---

`pendingDiff` registers untracked files as intent-to-add before diffing, so a file an agent created shows up in the patch instead of being invisible. Reviewers and judges previously saw imports of a file that appeared not to exist and refused sound fixes.
