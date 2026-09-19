---
"@cycgraph/orchestrator": patch
---

A2A artifacts named `__proto__`, `constructor`, or `prototype` are no longer used as result keys, and the delegation boundary now resolves output mappings with own-property semantics. A remote agent can no longer smuggle values into workflow memory through the prototype chain, where they would land untainted.
