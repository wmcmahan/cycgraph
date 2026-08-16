---
"@cycgraph/orchestrator": minor
"@cycgraph/memory": minor
---

Retrieval scores survive the trip to the prompt.

`MemoryIndex.searchFacts` has always returned scored results and `retrieveMemory` discarded them on the way out, so nothing downstream could tell a prompt full of weak matches from one full of strong ones.

`MemoryResult` gains an optional `scores` map keyed by fact id, populated on the embedding path. It carries only facts that were actually returned, so a caller cannot read a score for something it was never given, and facts reached through theme expansion have none. The entity and tag paths select rather than rank and report no scores at all — absent means "this query did not rank", not "scored zero".

`MemoryRetrievalResult.facts[]` gains an optional `score`, and the retrieval log line reports `score_min` / `score_max` when an adapter supplies them. Both additions are optional, so existing adapters are unaffected.
