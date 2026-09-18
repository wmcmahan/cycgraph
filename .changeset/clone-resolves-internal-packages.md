---
"@cycgraph/tools": patch
---

`linkNestedModules` now links every internal workspace package at the group level of the clone (`packages/node_modules/@scope/name` → the clone's own package), ahead of the root symlink to the source repository's dependency tree on Node's resolution walk. Before this, a consumer package's build inside a clone type-checked against the source checkout's stale dist, so a cross-package edit could never pass the clone's own checks — an unwinnable gate for any fix that adds to a dependency's exported types. Manifest names are validated against npm's name grammar before becoming link paths, and a directory the nested-link pass symlinked to the checkout is replaced by a real clone-local directory before anything is written beneath it, so clone contents can neither steer nor forward a write outside the clone.
