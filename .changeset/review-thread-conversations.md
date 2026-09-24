---
"@cycgraph/tools": minor
---

`listReviewThreads` now returns each thread's whole conversation, not only its first comment: every comment's author, association, body, and timestamp, plus the thread's current and original line, whether it is outdated, and the diff hunk it was left on. `prFeedback` tags each comment with its `source` (review body, conversation, or inline) and `createdAt`, so a caller can tell feedback that arrived after a given point. `submitPrReview` takes an optional `bodyWithoutComments`, submitted instead of `body` when the API rejects the inline comments, for a caller whose body leaves out what those comments carry. New `commentOnPrFile` comments on a whole file of a pull request, opening a review thread that can be replied to and resolved like a line comment.
