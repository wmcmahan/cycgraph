---
"@cycgraph/orchestrator": minor
---

Add `checkRequirements(target, host)`: preflight a composition or bundle against the host environment.

Pass a `Graph` to compute requirements from the composition closure, or a `GraphBundle` to check its manifest's declared `requires` — which is what makes a deserialized bundle checkable without running it. The host offers its `tools` (only `tool()` implementations satisfy required names), an `mcpServers` registry, and optionally a provider registry for an advisory model check. The result lists exactly what is missing, so a graph that cannot run fails at install or load time with a clear list instead of deep in execution:

```ts
const { ok, missingTools, missingMcpServers, unknownModels } =
  await checkRequirements(parseBundle(theirBundle), {
    tools: [lookupOrder],
    mcpServers: serverRegistry,
    providers: createProviderRegistry(),
  });
```

`ok` reflects the hard requirements (tools and MCP servers). `unknownModels` is advisory, matching the engine's model lists being advisory rather than an allowlist.
