---
"@cycgraph/tools": patch
---

`diagnosticsTool` now keeps the LAST lines of a failing check's output past the line cap instead of the first: test runners and linters print their failure detail and summary at the end, so head-keeping handed consumers pages of passing output with the actual reason truncated away. The truncation banner also changed: `[N earlier line(s) truncated]` at the START of the output replaces `[N more line(s) truncated]` at the end.
