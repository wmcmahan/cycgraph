---
"@cycgraph/studio": minor
---

Branch delivery helpers now live in `@cycgraph/tools/git` and are
re-exported here unchanged, joined by the new `publishBranch` (push the
branch and open the PR, falling back to a pre-filled create-PR URL when
`gh` is unavailable). `resolveApplyRepo` now checks whether the
repository tracks the target workflow's own source file when the catalog
knows it, instead of always asking whether the playground is tracked;
`config.applyRepo` still bypasses detection. The watch tick now
refreshes its corpus before sensing: runs any process recorded into the
shared persistence are imported into the artifact tree first, so
headless and CI runs against the same database join the improvement
loop without a manual `import`.
