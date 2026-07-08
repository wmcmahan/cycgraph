---
"@cycgraph/context-engine": minor
---

Token pruning no longer corrupts structured content.

The score-based pruning stage (used by the heuristic and self-information pruners, and the default `balanced` / `maximum` presets) dropped low-scoring whitespace-delimited tokens from any over-budget segment. That is meaning-preserving lossy compression for prose, but it **corrupted structured data** — dropping a key, value, or delimiter from serialized memory produced malformed output (e.g. `{"score": , "fact_id":"abc"}`) that the consuming model silently misread.

Pruning now skips structured segments: gated by role (`memory` / `tools` — format-independent, so it survives the format stage rewriting JSON into a compact non-JSON shape) with a JSON content-sniff backstop. An over-budget structured segment is passed through intact and compressed by the structure-aware stages (format, dedup) instead of being token-pruned.
