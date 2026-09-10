---
"@cycgraph/a2a": patch
---

Translate a bare `Message` reply from `message/send` into a completed task result whose `response` artifact carries the reply's parts. Agents that answer statelessly without creating a task no longer fail every `a2a` node with a fabricated failure that discarded the reply.
