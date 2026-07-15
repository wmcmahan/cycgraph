---
title: Security
description: Zero Trust model, state slicing, permission enforcement, and economic guardrails.
---

cycgraph operates under a **Zero Trust** security model built on three assumptions:

1. **Input is malicious** — users and external data may contain injection attacks
2. **Agents are fallible** — LLMs can be jailbroken or manipulated
3. **State is leaky** — agents should only see what they need to see

Every layer of the engine enforces these assumptions through concrete mechanisms described below.

## State slicing (least privilege)

Agents never see the full `WorkflowState`. Each agent and node declares explicit permissions:

```typescript
const WRITER_ID = registry.register({
  name: 'Writer',
  model: 'claude-sonnet-4-6',
  provider: 'anthropic',
  systemPrompt: '...',
  tools: [],
  permissions: {
    readKeys: ['goal', 'research_notes'],   // can only read these
    writeKeys: ['draft'],                    // can only write this
  },
});
```

At runtime, the engine creates a **state view** — a filtered projection of `WorkflowState.memory` containing only the keys listed in `read_keys`. An agent configured with `read_keys: ['goal', 'research_notes']` receives `undefined` for every other key, including `db_credentials`, `api_keys`, or any other sensitive data in state.

**Secure by default:** `read_keys` and `write_keys` both default to `[]`. A node that omits `read_keys` sees only `goal` and `constraints` — no memory keys — so state slicing protects you without opt-in. A node consuming an upstream output must declare it explicitly (`read_keys: ['research_notes']`).

The wildcard `read_keys: ['*']` grants access to all non-internal memory keys; `validateGraph` warns on it because it defeats slicing. Internal keys (prefixed with `_`, such as `_taint_registry`) are always excluded from state views, and `_taint_registry` is additionally append-only through reducers — a node cannot clear or weaken taint via a crafted memory write.

### Dot-notation nested key filtering

State slicing supports **dot-notation paths** for fine-grained access to nested objects. Instead of granting access to an entire top-level key, you can restrict an agent to specific nested paths:

```typescript
const WRITER_ID = registry.register({
  name: 'Writer',
  model: 'claude-sonnet-4-6',
  provider: 'anthropic',
  systemPrompt: '...',
  tools: [],
  permissions: {
    readKeys: ['user.name', 'user.email'],  // only these nested paths
    writeKeys: ['draft'],
  },
});
```

An agent with `read_keys: ['user.name', 'user.email']` receives a filtered `user` object containing only `{ name, email }` — all other fields (e.g. `user.ssn`, `user.api_key`) are excluded from its state view.

## Write permission enforcement

Write permissions are enforced at two levels:

1. **Agent executor** — After the LLM call completes, `validateMemoryUpdatePermissions()` checks every key the agent wrote against its `write_keys`. Unauthorized writes throw `PermissionDeniedError`.

2. **Graph runner** — Before any action is applied to state, `validateAction()` re-validates the action against the node's `write_keys`. This second check catches edge cases where actions are constructed outside the agent executor.

```
Agent LLM call → validateMemoryUpdatePermissions() → validateAction() → Reducer → State
                  ↑ PermissionDeniedError             ↑ PermissionDeniedError
```

Internal keys (prefixed with `_`) are reserved for the engine. Agents are blocked from writing `_`-prefixed keys by the agent executor's validation layer (`extractMemoryUpdates` rejects them). The GraphRunner's `validateAction()` skips `_`-prefixed keys during permission checks — they are treated as trusted system metadata injected by the executor (e.g. `_taint_registry`), not as agent-authored writes.

## Prompt injection sanitization

All agent inputs pass through a sanitization pipeline before reaching the LLM. These sanitizers defend against known prompt injection techniques:

- **NFKC Unicode normalization** — Converts lookalike characters (e.g. Cyrillic homographs like `а` → `a`) to their canonical forms, preventing visual spoofing attacks.
- **Carriage return stripping** — Removes `\r` characters that can be used to hide injected instructions in terminal-style overwrite attacks.
- **Consecutive newline normalization** — Collapses runs of 3+ newlines to 2, preventing whitespace-based prompt boundary confusion.
- **Directional override stripping** — Removes Unicode bidirectional override characters (U+202A–U+202E, U+2066–U+2069) that can reverse visible text direction to disguise injected content.
- **Base64-encoded injection detection** — Detects and rejects inputs containing base64-encoded strings that decode to known injection patterns (e.g. `ignore previous instructions`).

These sanitizers run on all agent system prompts and user messages before LLM invocation.

## Taint tracking

External data is the most dangerous attack vector. cycgraph automatically tracks the provenance of data entering the system from external tools.

**How it works:**

1. **Flagging** — All MCP tool results are automatically wrapped with taint metadata (source type, tool name, server ID, timestamp) via `wrapToolWithTaint()`. Both `agent` nodes and standalone `tool` nodes taint their MCP output.
2. **Propagation** — When an agent reads tainted input keys and writes output, `propagateDerivedTaint()` marks the outputs as `derived`-tainted, preserving the chain of custody.
3. **Inspection** — Downstream nodes can call `isTainted(memory, key)` or `getTaintInfo(memory, key)` to check provenance before trusting inputs.

Taint metadata is stored in `memory._taint_registry` — an internal key that is invisible to agents (stripped from every state view), **append-only** through reducers (a crafted memory write cannot clear or weaken taint), and accumulated per-execution so concurrent voting/evolution/map sub-runs never cross-attribute provenance.

### Strict taint mode

By default, tainted data in routing decisions produces a warning. Set `strict_taint: true` at the graph level to reject tainted data in routing decisions entirely:

```typescript
const graph = createGraph({
  name: 'High Security Workflow',
  strictTaint: true,  // reject tainted data in routing decisions
  nodes: [ /* ... */ ],
  edges: [ /* ... */ ],
  startNode: 'start',
  endNodes: ['end'],
});
```

When `strict_taint` is enabled, conditional edge expressions that reference tainted keys evaluate to `false`, and supervisor nodes that receive tainted routing inputs will refuse to route. See [Taint Tracking](/docs/concepts/taint-tracking/) for details on taint enforcement at decision points.

See [Taint Tracking](/docs/concepts/taint-tracking/) for the full API reference.

## Economic guardrails

Prevent runaway costs, infinite loops, and denial-of-wallet attacks with layered limits:

### Token budget

Set `max_token_budget` on the workflow state. The engine tracks `total_tokens_used` across all LLM calls and throws `BudgetExceededError` when the limit is hit.

```typescript
const state = createWorkflowState({
  workflowId: graph.id,
  goal: '...',
  maxTokenBudget: 50_000,
});
```

### Cost budget (USD)

Set `budget_usd` for dollar-denominated limits. The engine calculates costs using a per-model pricing table and fires threshold alerts at **50%**, **75%**, **90%**, and **100%** of the budget:

```typescript
const state = createWorkflowState({
  workflowId: graph.id,
  goal: '...',
  budgetUsd: 1.00,
});
```

At 100%, execution halts with `BudgetExceededError`. Listen for threshold events to add monitoring:

```typescript
runner.on('budget:threshold_reached', ({ threshold_pct, cost_usd, budget_usd }) => {
  console.warn(`Budget ${threshold_pct}% reached: $${cost_usd.toFixed(4)} of $${budget_usd}`);
});
```

See [Cost & Budget Tracking](/docs/concepts/cost-tracking/) for model pricing details and the `UsageRecorder` interface.

### Iteration limit

`max_iterations` (default: **50**) caps the total number of graph loop iterations. This prevents cyclic graphs from running forever:

```typescript
const state = createWorkflowState({
  workflowId: graph.id,
  goal: '...',
  maxIterations: 20,
});
```

### Execution timeout

`max_execution_time_ms` (default: **1 hour**) sets a wall-clock deadline. The engine checks elapsed time before each node execution and throws `WorkflowTimeoutError` if exceeded:

```typescript
const state = createWorkflowState({
  workflowId: graph.id,
  goal: '...',
  maxExecutionTimeMs: 120_000,  // 2 minutes
});
```

### Agent step limit

Each agent has a `max_steps` setting (default: **10**, maximum: **50**) that limits the number of tool-call iterations within a single LLM invocation. This prevents agents from entering infinite tool-call loops.

### Agent timeout

Each agent invocation has a **2-minute** timeout (configurable via `timeout_ms`). If the LLM call doesn't complete within the limit, an `AgentTimeoutError` is thrown and the node fails (subject to its retry policy).

## MCP tool security

Agents never see MCP server transport configurations or secrets.

### Trusted MCP Server Registry

Server connection configs (URLs, commands, auth headers) live in the **MCP Server Registry** — an admin-only data store. Agent configs reference servers by ID only:

```typescript
// Agent config — no transport details, no secrets
tools: [
  { type: 'mcp', serverId: 'web-search' },
]
```

### Access control

Each server entry can restrict which agents may use it via `allowed_agents`:

```typescript
await registry.saveServer({
  id: 'admin-tools',
  name: 'Admin Tools',
  transport: { type: 'http', url: 'https://internal.example.com/admin' },
  allowedAgents: ['admin-agent-001'],
});
```

When `allowed_agents` is set, the `MCPConnectionManager` validates the requesting agent's ID before resolving tools. Unauthorized access throws `MCPAccessDeniedError`.

### Transport restrictions

- **stdio** — Only allowlisted commands (`npx`, `node`, `python3`, `python`, `uvx`). No arbitrary shell execution.
- **http/sse** — URLs stored in the registry, never in agent configs. Secrets stay server-side.
- **SSRF guard** — http/sse URLs are blocked from resolving to private, loopback, link-local, or cloud-metadata addresses (`169.254.169.254`, `127.0.0.1`, RFC1918, `[::1]`, `fc00::/7`, …). Set `CYCGRAPH_ALLOW_PRIVATE_MCP_URLS=true` to allow them for local development.

### Registry validation at the trust boundary

`saveServer` and `loadServer` re-validate every entry through `MCPServerEntrySchema` on **both** write and read — not just at compile time. The stdio allowlist and SSRF guard are therefore enforced even against a JS caller, an `any` cast, a direct SQL write, or a migration. An entry with a disallowed command or a private-IP URL is rejected before it can ever be spawned or connected.

### Automatic taint wrapping

All MCP tool results are wrapped with taint metadata before being returned to agents, ensuring every piece of external data is tracked from the moment it enters the system.

See [Tools & MCP](/docs/concepts/tools-and-mcp/) for the full MCP integration guide.

## Workflow Architect publish gate

The Architect can generate executable graphs from natural language, but `architect_publish_workflow` never persists an unvalidated graph: it runs `GraphSchema.parse` + `validateGraph` first, so a prompt-injected or buggy agent cannot publish a graph with wildcard reads, unbounded fan-out, or arbitrary tool wiring. Wire `ArchitectToolDeps.canPublish` to additionally require human approval or a privileged credential before any publish reaches the registry:

```typescript
initArchitectTools({
  saveGraph, loadGraph,
  canPublish: async (graph) => {
    // return true to allow, or a string reason to deny
    return (await isApprovedByHuman(graph.id)) || 'human approval required';
  },
});
```

## Resource bounds (DoS guards)

Every fan-out and iteration knob is capped at the schema level so a hand-written or generated graph can't trigger a fan-out bomb: `population_size ≤ 100`, `max_generations ≤ 100`, `max_concurrency ≤ 50`, `voter_agent_ids ≤ 50`, supervisor/annealing `max_iterations ≤ 1000`. Subgraph nesting is capped at depth 32, and subgraphs inherit the parent's guardrails (tool resolver, fact sanitizer, memory writer, model resolver) rather than running with reduced guarantees.

## Supervisor routing validation

Supervisor nodes validate every LLM routing decision against their `managed_nodes` allowlist. If the LLM attempts to route to a node not in the list, a `SupervisorRoutingError` is thrown. This prevents prompt injection attacks from hijacking workflow control flow.

## Human-in-the-loop as security

For high-stakes actions, use `approval` nodes to pause execution for human review:

1. A preceding node proposes an action and saves it to state
2. The workflow pauses at the approval gate (status becomes `waiting`)
3. A human reviews and approves or rejects
4. Execution resumes only after approval

See [Human-in-the-Loop](/docs/patterns/human-in-the-loop/) for the implementation pattern.

## Immutable audit trail

Every state transition is logged as an action with:
- Which node produced it
- When it was applied
- What the previous state was
- An idempotency key (`{node_id}:{iteration_count}`) to prevent duplicate execution on retries

This enables full audit trails and time-travel debugging via the event log.

## Error classes

All security-related errors are typed and exported from `@cycgraph/orchestrator`:

| Error | Thrown when |
|-------|------------|
| `PermissionDeniedError` | Agent writes to unauthorized memory key |
| `BudgetExceededError` | Token or cost budget exceeded |
| `WorkflowTimeoutError` | Execution time exceeds `max_execution_time_ms` |
| `AgentTimeoutError` | Single agent call exceeds timeout |
| `MCPAccessDeniedError` | Agent not in server's `allowed_agents` list |
| `MCPServerNotFoundError` | Server ID not found in registry |
| `SupervisorRoutingError` | Supervisor routes to unauthorized node |

## Next steps

- [Taint Tracking](/docs/concepts/taint-tracking/) — full taint API reference
- [Cost & Budget Tracking](/docs/concepts/cost-tracking/) — pricing tables and usage recording
- [Tools & MCP](/docs/concepts/tools-and-mcp/) — MCP server registry and access control
- [Persistence](/docs/concepts/persistence/) — state versioning and event log
