---
"@cycgraph/tools": minor
---

Workspace tools: `search`, `read_file`, `edit_file`, and `diagnostics` over
one jailed directory — the surface a code-editing agent gets. Paths resolve
through a jail that refuses escapes; reads are line-windowed with markers and
tainted; the edit tool refuses an absent or ambiguous match rather than
guessing. The `workspaceTools(root)` bundle arms read-before-edit as harness
discipline: a shared session hashes content at read, and edits are refused
for files never read or changed since. `diagnosticsTool` runs one
caller-configured check and returns `{ clean, output }`, so an editing agent
can see its own breakage and iterate — the agent chooses no command, only
asks the configured question. Each tool's Zod schema is exported beside its
factory so transports never restate parameters.
