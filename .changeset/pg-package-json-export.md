---
"@cycgraph/orchestrator-postgres": patch
---

Expose `./package.json` through the exports map, so tooling (e.g. a project-local migration script locating the shipped `drizzle/` folder) can resolve the package root.
