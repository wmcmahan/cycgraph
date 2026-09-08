---
'@cycgraph/tools': minor
---

New workspace tool `create_file`: the write hand that brings a file into
existence, so an agent driving a jailed workspace can add a module, a test, or
a changeset instead of only modifying what is already there. Paths resolve
through the same jail as the rest of the surface and parent directories are
created under the root only; contents are capped at 1 MiB by default. It is
new-file-only — an existing path is refused with `error: ... already exists —
use edit_file to change it` — so `edit_file`'s read-before-edit and
unique-match refusals cannot be routed around by overwriting. A successful
create records the new content in the shared `WorkspaceSession`, letting an
agent edit the file it just wrote with no intervening read, and
`workspaceTools(root)` now bundles it beside `search`, `read_file`, and
`edit_file`. `createFileParameters` is exported beside the factory so
transports never restate the schema. The tool does not taint: it reports back
only a confirmation of the agent's own text.
