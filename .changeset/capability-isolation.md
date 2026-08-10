---
"@cycgraph/orchestrator": minor
---

Capability isolation for bundle children: a graph cannot use more than its manifest declared.

A bundle's `requires` is now an enforced ceiling, not documentation. When a composition embeds a bundle, its child runner receives a `CapabilityCeiling` derived from the manifest, and enforcement is fail-closed at two layers: the startup wiring check rejects a child graph whose nodes reference a custom tool or MCP server outside the ceiling, and the tool-resolution choke point throws `CapabilityViolationError` for out-of-ceiling sources arriving any other way — including tools on agent configs resolved from the registry at runtime. An invoked parent agent gains nothing, because its tools still resolve under the child's ceiling.

Nesting can never escape a cap: a child with no declared ceiling inherits its parent runner's, and a bundle nested inside a bundle is capped by the intersection of both manifests. Combined with `checkRequirements`, this completes the app-permissions model — the preflight shows a human exactly what a bundle asks for, and enforcement guarantees the runtime surface matches the reviewed declaration. A tampered bundle whose manifest under-declares what its graph uses now fails instead of silently reaching the host's full tool surface.

Raw graphs and non-bundle subgraph children are unchanged. New public surface: `CapabilityCeiling`, `CapabilityViolationError`, `intersectCeilings`, and the `capabilityCeiling` / `capabilityCeilings` options on `GraphRunnerOptions`.
