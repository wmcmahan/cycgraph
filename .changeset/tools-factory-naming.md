---
'@cycgraph/tools': minor
---

Rename every tool factory to drop the `create` prefix: `createWebFetchTool` is now `webFetchTool`, `createCalculatorTool` is now `calculatorTool`, and so on for all twelve exports across the `web`, `data`, `memory`, and `sandbox` subpaths. Update imports and call sites; the options types and behavior are unchanged.
