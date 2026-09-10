---
"@cycgraph/a2a": patch
---

A multi-part `status.message` is no longer dropped: every part now contributes to `A2ATaskResult.message`, joined by newline in wire order, so an `input-required` pause still shows the remote agent's question when it arrives as more than one part.
