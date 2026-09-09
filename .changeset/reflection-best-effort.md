---
"@cycgraph/orchestrator": patch
---

Reflection nodes treat LLM extractor failures as best-effort: an extraction error (structured output not matching the schema, a transient provider error) rethrows while the node has retries left and degrades to zero facts on the final attempt — the result envelope carries `extractor_failed: true` — instead of failing a run whose productive work already succeeded. Configuration errors such as a missing `memoryWriter` stay loud.
