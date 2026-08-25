---
"@cycgraph/orchestrator": patch
---

runRecorded persists the composition's child graphs alongside the root, so child-session rows reference graph ids the store actually holds and later readers (fork resolution, importers) resolve them without the recording process's in-memory closure.
