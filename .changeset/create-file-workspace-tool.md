---
"@cycgraph/tools": minor
---

New workspace tool `create_file`: the write hand that brings a file
into existence, so an agent driving a jailed workspace can add a
module, a test, or a changeset instead of only modifying what already
exists. Paths resolve through the same jail as the rest of the surface,
parent directories are created under the root only, and contents are
capped at 1 MiB by default. It is new-file-only — an existing path is
refused, so `edit_file`'s read-before-edit and unique-match refusals
cannot be routed around by overwriting. A successful create records the
content in the shared `WorkspaceSession`, letting an agent immediately
edit the file it just wrote, and `workspaceTools(root)` bundles it
beside search, read, and edit. Designed by the feat-implement
workflow's agent; landed by hand after review.
