---
"@cycgraph/tools": minor
---

PR feedback helpers for review-driven revision loops: `pushBranch` pushes a workspace branch to a branch that already has a pull request (factored out of `publishBranch`), `prFeedback` reads a PR's review bodies, conversation comments, and diff-anchored line comments (undefined when unreadable), and `commentOnPr` posts a reply.
