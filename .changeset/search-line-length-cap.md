---
"@cycgraph/tools": patch
---

`searchTool` caps each reported matching line at `maxLineLength` characters (default 400) with a truncation marker. A match inside a single-line data blob previously put megabytes into one tool result, oversizing every later request of the agent's turn. The substring match still runs on the full line; the cap applies only to what is reported.
