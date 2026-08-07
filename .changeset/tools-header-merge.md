---
"@cycgraph/tools": patch
---

`http_request` now lowercase-normalizes header names before merging operator `defaultHeaders` over LLM-supplied headers. Header names are case-insensitive on the wire but the previous object-spread merge was case-sensitive, so a model sending `Authorization` alongside an operator default of `authorization` produced two entries that fetch joined into one corrupt header value. Operator defaults now always win regardless of casing.
