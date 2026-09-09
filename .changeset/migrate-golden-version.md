---
"@cycgraph/evals": patch
---

`migrate-golden` writes migrated datasets under the next MAJOR schema version derived from the manifest (via the new `nextMajorSchemaVersion` export) instead of a hardcoded `1.0.0`, which overwrote the retained v1 rollback file and downgraded the manifest entry.
