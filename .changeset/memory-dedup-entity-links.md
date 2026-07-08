---
"@cycgraph/memory": minor
---

Dedup preserves the loser's entity links.

When `MemoryConsolidator` merges two near-duplicate facts, it now unions the loser's `entity_ids` into the survivor (alongside the existing episodes / tags / access-count merge). Previously the loser's entity links were dropped, so if the duplicates referenced different entities the survivor silently lost its link to the loser's — and entity-scoped retrieval and conflict detection (both group by `entity_id`) stopped seeing the merged fact for those entities.
