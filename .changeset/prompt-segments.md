---
"@cycgraph/orchestrator": minor
---

BREAKING: `ContextCompressor` now receives the whole prompt as segments.

The compressor is called once per prompt with every variable-size section
(`system`, `goal`, `retrieved`, `task_context`, `memory`, `instructions`,
plus `routing_history` for supervisors) instead of a single memory blob, so
one budget can be allocated across the prompt. Locked segments must be
returned byte-identical or the whole result is discarded. Memory now
reaches the compressor uncapped; byte caps apply to output as a backstop.

Also: agents accept `maxOutputTokens` (no default; forwarded to providers
and to the compressor as `outputReserve`), and the agent executor captures
the provider error from the stream, so failures like a 401 surface with
their real message and stop retrying instead of reporting "No output
generated" after three attempts.
