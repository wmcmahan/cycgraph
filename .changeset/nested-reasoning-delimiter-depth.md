---
"@cycgraph/context-engine": patch
---

Chain-of-thought distillation now matches the outermost close tag by tracking nesting depth per delimiter, so a nested reasoning block (e.g. `<think>...<think>...</think>...</think>`) collapses into a single distilled block instead of leaking the remaining reasoning text and a dangling close tag into the prompt.
