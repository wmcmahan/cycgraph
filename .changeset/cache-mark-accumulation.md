---
"@cycgraph/orchestrator": patch
---

Cache breakpoints no longer accumulate across agent steps. Marks
persisted in the loop's stored messages, so each request carried every
earlier step's markers plus the new window, exceeding Anthropic's
four-breakpoint limit — and the provider then dropped the newest,
most useful ones. Marks outside the trailing window are now stripped
before the window is marked.
