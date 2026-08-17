---
"@cycgraph/orchestrator": patch
---

The examples are type-checked.

Every package excluded `examples/**` from its tsconfig `include`, so nothing checked them — they ran under `tsx`, which does not type-check. Two real defects had been sitting there unseen, one of them consequential: `postgres-persistence` set `provider` twice in each agent config, so a hardcoded `'anthropic'` silently overrode the configured `PROVIDER` and the example could never run against a local model. `hardening-validation` passed a string where its security policy wants a list.

The `graph-interface` example also imported without file extensions throughout, which the project's own ESM standard requires; directory imports now name `index.js` explicitly.

Checking runs through a separate `tsconfig.examples.json` rather than the build config, whose `rootDir` is `src/` and whose declaration emit makes an exported node value unnameable. `npm run lint` runs it after the src pass, so it needs a build first — examples resolve the package through `dist/`.
