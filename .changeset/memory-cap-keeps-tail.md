---
"@cycgraph/orchestrator": patch
---

Prompt-memory truncation now cuts the middle instead of the tail. Reducers append, so the newest keys serialize last; the old head-only cut removed exactly the evidence a feedback loop had just written for its retrying agent. An oversized memory block now keeps both ends with a visible marker at the cut, and both cut points respect UTF-8 sequence boundaries so the seam never decodes as replacement characters.
