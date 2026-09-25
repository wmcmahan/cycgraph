---
"@cycgraph/orchestrator": patch
---

An `a2a` node whose remote task is still running when its wait bound fires now logs `a2a_task_pending` with the `task_id` instead of `a2a_transport_failed`, so logs no longer report a live remote task as a transport failure.
