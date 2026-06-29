---
"@cycgraph/orchestrator": minor
---

Prompt-injection firewall: a taint-aware security policy enforced before nodes run, plus full taint propagation across retrieval and composition.

**Security policy port (new).** A new injectable `securityPolicy` option on `GraphRunnerOptions` (same adapter pattern as `factSanitizer`/`memoryRetriever`: the engine owns the mechanism, the caller owns the policy). It is consulted BEFORE each node executes — but only for nodes that read tainted data — and returns one of four effects: `allow`, `monitor` (emit a `security:policy` event and continue), `block` (fail the run closed via `SecurityPolicyViolationError`), or `require_approval` (inject a `request_human_input` gate before the node runs; approve → the node runs, reject → the run cancels). Because enforcement is pre-execution, the guarantee is model-independent: a fully prompt-injected agent still cannot execute the gated action. New exports: `SecurityPolicy`, `SecurityPolicyContext`, `SecurityPolicyDecision`, `SecurityPolicyEffect`, `SecurityPolicyViolationError`, `readableTaintedKeys`. New runner event `security:policy` (one per non-`allow` decision, for durable audit).

**Taint now propagates where it previously leaked.**
- `createStateView` re-attaches the `_taint_registry` (filtered to the node's readable keys) so the agent executor's `propagateDerivedTaint` actually sees tainted inputs — derived-taint propagation was silently a no-op before. `sanitizeForPrompt` strips all `_`-prefixed system keys, so the taint registry stays executor-only and never reaches the model prompt.
- Edge conditions can route on taint: `runner/conditions.ts` exposes top-level `tainted` (bool) and `tainted_keys` (array) to filtrex expressions.
- New taint source `retrieval`: when a node's `memory_query.untrusted` is set (RAG over external/user documents), the agent's outputs are marked tainted so a poisoned document cannot drive a downstream sensitive action ungated. New optional `untrusted` field on `MemoryQuerySchema` (additive).
- Subgraphs no longer launder taint: the subgraph executor carries taint across the input mapping (parent → child) and output mapping (child → parent).

**HITL across composition.** The `securityPolicy` propagates into subgraph child runners, so a tainted→sensitive action inside a subgraph is gated too. A gated child surfaces as a parent pause: the subgraph executor stashes the child checkpoint and re-enters/resumes the child on approval. `RequestHumanInputPayloadSchema` gains an optional `memory_updates` field (additive — applied before `_pending_approval` so it cannot clobber it) used to stash that checkpoint.

Replay-safe and additive: no `REPLAY_VERSION` bump, and graphs that declare no policy / no `memory_query.untrusted` are unaffected. Fixes an ordering bug where a gated END node completed instead of pausing.
