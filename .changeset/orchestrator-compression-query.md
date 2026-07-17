---
"@cycgraph/orchestrator": minor
---

Prompt construction passes the sanitized workflow goal to the context compressor as `options.query`. `ContextCompressor` options gain an optional `query` field; agent and supervisor prompts both supply it. Compressors that forward it to `@cycgraph/context-engine`'s `compress()` get relevance-aware allocation — budget concentrates on goal-relevant memory (measured on HotpotQA at a 0.3 compression target: retains 67/82 answerable questions vs 51/82 for LLMLingua-2 and 47/82 for query-agnostic compression). Compressors that ignore the new option behave exactly as before.
