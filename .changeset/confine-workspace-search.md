---
"@cycgraph/tools": patch
---

The workspace search tool now resolves every file through the jail and skips symlinks that point outside the root, so a committed link can no longer put host files into a search result.
