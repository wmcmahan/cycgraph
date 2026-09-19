---
"@cycgraph/tools": patch
---

The workspace jail now resolves paths through `realpath` (or the deepest existing ancestor, for new files) and refuses any path whose real target leaves the root. A symlink planted inside a workspace — such as a linked `node_modules` — can no longer be used by `read_file`, `edit_file`, or `create_file` to read or write outside the sandbox.
