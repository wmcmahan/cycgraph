---
"@cycgraph/orchestrator": minor
---

Architecture & API hygiene (Phase 6): tighten the public surface and close a status-resurrection hole.

**Status-transition guard (correctness).** A shared guard now governs every status write (both the public `set_status` reducer and the internal lifecycle reducer). A run that has reached a terminal state (`completed`, `failed`, `cancelled`, `timeout`) can no longer be moved back to an active status — previously a stray `set_status`, or a replayed `_init` on a recovered run, could flip `failed` → `running` and resurrect a dead run. Terminal→terminal transitions remain allowed for saga rollback (`failed`/`timeout` → `cancelled`). New exports: `canTransitionStatus`, `isTerminalStatus`, `TERMINAL_STATUSES`.

**Node-type executor registry.** The 12-case dispatch `switch` in `GraphRunner` is replaced by a `Record<NodeType, NodeExecutor>` registry (`runner/node-executors/registry.ts`). Adding a node type is now a single registration that the compiler enforces is exhaustive, instead of shotgun edits across the runner. New exports: `NODE_EXECUTORS`, `SUPPORTED_NODE_TYPES`, `getNodeExecutor`, and the `NodeExecutor` type.

**Public API hygiene (BREAKING).** Engine internals that were leaking through the root entry point are moved behind a new `@cycgraph/orchestrator/internal` subpath: `internalReducer`, `StreamChannel`, the filtrex condition internals (`FILTREX_EXTRA_FUNCTIONS`, `FILTREX_COMPILE_OPTIONS`, `normalizeConditionExpression`), and the low-level `calculateBackoff` / `sleep` helpers. They are no longer part of the semver contract — import them from `@cycgraph/orchestrator/internal` if you genuinely need them (first-party tooling only). The public condition evaluator `evaluateCondition` stays on the root. Wildcard `export *` of the reducers/helpers/conditions barrels is replaced with explicit named exports so the public surface is auditable.

**Dropped the phantom `@cycgraph/context-engine` peerDependency.** The orchestrator integrates the context engine purely via an injected function type (`ContextCompressor`) and never imports the package, so the (optional) peer dependency was noise. Removed.
