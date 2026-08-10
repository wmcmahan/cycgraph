---
"@cycgraph/orchestrator": minor
---

Bundle manifests can carry provenance: an optional `source` recording where the bundle is distributed from, e.g. an npm package name. Set it at assembly with `bundle(g, { version, source: 'npm:@acme/research-graph' })`. Self-declared attribution for audit trails; for npm distribution, integrity already rides the consumer's lockfile, and `source` records that linkage in the artifact itself. Cryptographic verification is deliberately deferred.
