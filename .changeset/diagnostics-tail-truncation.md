---
"@cycgraph/tools": minor
---

Additions to the git surface: `commentOnIssue` and `addIssueLabel` (the label is created on the repository when missing), used by workflows that flag an issue as waiting on a human; `viewIssue`, one issue's title and body by number, for briefing a reviewer on the intent a PR claims to serve; and `prFeedback` now carries the PR `body`, so a review can read the description and its `Closes #N` linkage instead of only the title. `diagnosticsTool` output past the line cap now surfaces failure-marker lines (`FAIL`, `npm error`, `Error:` and its subclasses) ahead of the tail under a count header, so a multi-workspace test run cannot bury its failing suite under a later workspace's passing output; header and separator count against the cap. Each reported line is also capped at `maxLineLength` characters (default 400) with a truncation marker, because a line cap alone bounds nothing when structured-log emitters put kilobytes on a single line.
