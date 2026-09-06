---
"@cycgraph/tools": minor
---

New `@cycgraph/tools/git` subpath: caller-side git delivery for
workflows that write to a repository. Branch mechanics (`cloneToBranch`
— which also links nested `packages/*/node_modules` trees into the
clone, so clone-side tooling resolves non-hoisted dependencies —
`commit` with a configurable identity, `changedIn`, `pendingDiff`,
`publishScript`, `publishBranch` — push and open the PR, degrading to a
pre-filled create-PR URL when `gh` is unavailable), `PublishConfig`
resolved from the environment by `publishConfigFromEnv` (`GH_TOKEN` /
`GITHUB_TOKEN`, `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL`), PR bodies that
follow the target repository's `.github/PULL_REQUEST_TEMPLATE.md` via
`prBodyFor` (prose sections filled from run evidence, checklists left
for the human), and `deliveryNodes` — the clone/commit/publish tail of
the maintenance pattern as wired graph nodes, batch-aware: a graph that
cycles back through commit delivers one commit per verified fix on one
branch, accumulating count and details, with `branchDiff` spanning the
whole branch. `openPrFiles` lists the files open PRs under a branch
prefix already touch, so a workflow can defer work a human owes a
decision on, and the issue-ledger helpers (`listOpenIssues`,
`createIssue`, `findingMarker`, `issueMarkers`) let a workflow file
findings as deduped GitHub issues — an unreadable ledger reads as
"cannot see", never as "none". These are procedures for the code
driving a jailed workspace, deliberately not `defineTool` surfaces.
