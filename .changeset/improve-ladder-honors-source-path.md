---
"@cycgraph/studio": patch
---

The improve ladder's built-in apply stage now briefs the editor on, edits, typechecks, and verifies the workflow's own declared source file instead of assuming this repository's `packages/playground` layout, so `play improve` works on a host repository's workflows.
