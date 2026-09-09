---
"@cycgraph/memory": patch
---

`retrieveMemory` accepts a partial query (`MemoryQueryInput`, newly exported) and parses it through `MemoryQuerySchema`, so callers rely on schema defaults instead of spelling out every defaulted field; an invalid query now fails loudly at the call.
