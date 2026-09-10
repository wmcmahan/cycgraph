---
"@cycgraph/tools": minor
---

`prFeedback` now reports the PR's label names and stamps every relayed comment with the author's repository association, so consumers that treat comment text as instructions can gate on it — commenting needs no permission, making association the only trust signal a comment carries. `PublishConfig` accepts `labels` to apply to a pull request on creation (best-effort — a label the repository lacks is skipped, never a failed publish).
