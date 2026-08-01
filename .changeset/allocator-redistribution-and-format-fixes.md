---
"@cycgraph/context-engine": patch
---

Budget allocator and formatting fixes. No API changes; allocation outputs improve for mixed-size segment sets.

- **The proportional allocator now spends the whole budget.** The surplus-redistribution pass was dead code: the first pass already capped every allocation at the segment's actual size, so the "donated surplus" it looked for was always zero, and budget freed by capped segments was silently left unspent. Measured repro: two equal-priority segments of 2 and 500 tokens under a 200-token budget allocated {2, 101} and dropped 97 tokens on the floor; they now allocate {2, 198}. The second pass redistributes unspent budget to segments that still need more, proportionally to their need, with a full-grant shortcut when the freed budget covers every remaining need.
- **`allocateBudget` reports overflow when every segment is locked.** Locked segments whose combined size exceeds the available budget were detected but the early return for "no mutable segments" discarded them, returning `overflow: []`. Callers can now see the overflow they need to react to.
- **The nested format strategy renders `Date` values as ISO strings.** A `Date` fell through to the object path and serialized as `{}` at every level (top-level, object property, array element, inline array-of-objects). It now formats as `toISOString()`, matching the tabular and flat-object strategies.
- **The heuristic scorer's cross-segment frequency fallback matches the n-gram scorer.** An explicitly empty `allContent` array produced an empty frequency corpus (neutral scores for every token); it now falls back to the segment's own content, the same behavior as `createNGramScorer`.
