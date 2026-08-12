---
"@cycgraph/memory": minor
---

`checkFactAdmission`: similarity-based admission gate for `MemoryWriter`
adapters. Refuses restatements of stored facts and re-entry of anything
`invalidated_by` (including eval-gate evictions). Token-overlap comparison
by default; pass `embeddings` for cosine. The lexical default only catches
near-verbatim repeats; reflection loops that re-derive claims need
embeddings, and the module documentation carries the measurements.
