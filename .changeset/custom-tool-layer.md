---
"@cycgraph/orchestrator": minor
"@cycgraph/orchestrator-postgres": patch
---

Custom tool layer: `defineTool()` + a single `tools` runner option.

- New `defineTool({ name, description, parameters, execute, taints?, timeoutMs? })` helper: Zod-validated arguments on every call, per-call timeout (30s default), eager spec validation, and opt-in taint tracking (`taints: true` records results in `state.taint_registry` with the new `custom_tool` source).
- New `{ type: 'custom', name }` tool-source variant, plus authoring sugar everywhere tools are declared: bare names (`'save_to_memory'`, `'lookup_order'`) and `{ mcp: id, tools: [...] }` server refs normalize to the structured wire form at authoring boundaries, so stored graphs and agent configs never carry the sugar.
- BREAKING: `GraphRunnerOptions.toolResolver` is replaced by `tools?: Array<DefinedTool | ToolResolver>` — one option for everything that provides tools. Migration is mechanical: `toolResolver: manager` → `tools: [manager]`. Resolution precedence is built-ins → defined tools → resolvers; unresolvable custom names and MCP sources without a resolver fail the preflight wiring check.
- Built-in tool definitions consolidated into a single catalog (`save_to_memory` no longer duplicated across the connection manager and fallback resolver).
- `@cycgraph/orchestrator-postgres`: the agent registry normalizes tool-source sugar at register/update, so persisted rows always store the structured wire form.
