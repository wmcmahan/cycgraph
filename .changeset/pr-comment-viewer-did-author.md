---
"@cycgraph/tools": minor
---

`prFeedback` now reports which comments the reading token wrote. `PrComment` gains an optional `viewerDidAuthor`, GitHub's own flag for whether the viewer authored the comment. Unlike a login it cannot be spoofed, and it still holds when a GitHub App posts as `name[bot]` with an untrusted `authorAssociation`.

- Conversation comments carry the flag that `gh pr view` returns.
- Review bodies are now read through GraphQL, which carries the flag and reads every page of reviews. Empty review bodies are still dropped, and `source` and `createdAt` are unchanged.
- Inline comments come from the REST API, which has no viewer flag, so they leave the field absent. `listReviewThreads` already carries it for them.

Existing consumers are unaffected: the field is optional and no other `PrComment` field changes.
