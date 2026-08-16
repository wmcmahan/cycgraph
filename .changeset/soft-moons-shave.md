---
"@cycgraph/orchestrator": minor
---

Retrieval reports what it did, not only when it fails.

`retrieveForPrompt` logged a warning when the retriever threw and was otherwise silent, so a query that returned nothing was indistinguishable from a retriever that was never consulted. Both are common and they need different fixes: one is an empty store or a wrong tag, the other is a missing `memory_query` directive.

It now opens a `memory.retrieve` span and emits a `memory_retrieved` log line carrying the node that asked, the query's tags and shape, the cap, how many facts, entities, and themes came back, and how long it took. Failures carry the node id too.

The line also counts `facts_without_id`. A `MemoryRetrievalResult` fact without an `id` cannot be recorded in lesson provenance, so an adapter that strips ids silently disables eval-gated learning — a documented trap with no previous signal.

Retrieval scores are still absent, because the `MemoryRetriever` port returns facts without them. Surfacing why a fact was chosen, or what was retrieved and rejected, needs a change to that contract.
