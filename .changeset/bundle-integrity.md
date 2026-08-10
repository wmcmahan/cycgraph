---
"@cycgraph/orchestrator": minor
---

`parseBundle` now cross-checks a bundle's visible usage against its manifest.

A bundle whose graphs' node sources or bundled agents reference a custom tool, MCP server, or model that the manifest's `requires` never declared is rejected at load time with `BundleIntegrityError`, listing every violation. This moves the common tamper case — a manifest under-declaring to sneak past review — from run time to load time. The runtime capability ceiling remains in place as defense in depth for the one path a bundle cannot show at parse: host-supplied agents referenced by id.
