---
title: Troubleshooting
description: Common errors a new user will hit, what they mean, and how to fix them.
---

If your first cycgraph workflow doesn't behave the way you expect, this page lists the errors most users hit early and the misconfigurations that cause them.

## Install / startup

### `EBADENGINE Unsupported engine`

```
npm warn EBADENGINE Unsupported engine {
  package: '@cycgraph/orchestrator@0.1.0-beta.X',
  required: { node: '>=24.0.0' },
  current: { node: 'v22.x.x' }
}
```

cycgraph requires **Node.js 24+**. Upgrade Node (e.g. `nvm install 24 && nvm use 24`) and reinstall.

### `Cannot find module` / missing `.js` extensions

cycgraph packages ship as ES modules. If you import without the explicit `.js` extension and your `tsconfig.json` uses `"module": "Node16"` or `"NodeNext"`, you'll get module-resolution errors.

```typescript
// ❌ Will fail in Node16/NodeNext
import { GraphRunner } from '@cycgraph/orchestrator/src/runner/graph-runner';

// ✅ Always import from the package root
import { GraphRunner } from '@cycgraph/orchestrator';
```

## Configuration errors

### `AgentNotFoundError: Agent "X" not found`

You're running a graph that references an `agent_id` that wasn't registered. Register every agent on the `InMemoryAgentRegistry` (or load via `DrizzleAgentRegistry`) **before** instantiating `GraphRunner`, then call `configureAgentFactory(registry)`.

```typescript
const registry = new InMemoryAgentRegistry();
const RESEARCHER_ID = registry.register({ /* config */ });
configureAgentFactory(registry);   // ← required
```

### `UnsupportedProviderError: Provider "X" is not registered`

`provider` on your agent config doesn't match a registered provider. Anthropic and OpenAI are built in via `createProviderRegistry()`; everything else needs explicit registration (`registerOllamaProvider`, custom factory).

### `NodeConfigError: <type> node "<id>" is missing <field>`

You declared a node of a given type but omitted its required config block. The typical culprits:

| Node type | Required field |
|---|---|
| `agent` | `agent_id` |
| `supervisor` | `supervisor_config` (or `agent_id` if `supervisor_config.agent_id` is unset) |
| `approval` | `approval_config` |
| `map` | `map_reduce_config` |
| `subgraph` | `subgraph_id` + `subgraph_config` |
| `voting` | `voting_config` |
| `evolution` | `evolution_config` |
| `verifier` | `verifier_config` |
| `reflection` | `reflection_config` |
| `tool` | `tool_id` |

## Runtime errors

### `PermissionDeniedError: agent attempted to write key "X"`

The agent emitted a `save_to_memory` call for a key not in the node's `write_keys` (or used the `_`-prefixed reserved namespace). Either:
- Add the key to the node's `write_keys`, or
- Update the agent prompt to stop writing it, or
- Use `default_write_key` to channel free-form text output to a specific allowed key.

### `BudgetExceededError: Token budget exceeded`

Workflow-wide token budget breached. Either raise `state.max_token_budget` or, more usefully, add `budget` per-node so a single runaway call doesn't eat the run:

```typescript
{
  id: 'reflect',
  type: 'reflection',
  // ...
  budget: { max_tokens: 20_000, max_cost_usd: 0.05 },
}
```

### `NodeBudgetExceededError: Node "X" exceeded max_tokens`

A single node breached its `budget` cap. Unlike `BudgetExceededError`, this one fires per-attempt — retries do not stack toward the cap. Common culprits:
- LLM reflection extractor without `max_facts` cap.
- Annealing loop with a high `max_iterations`.
- Agent with bloated `tools` array driving up input tokens.

### `WorkflowTimeoutError: Workflow ... timed out after Xms`

Wall-clock cap (`state.max_execution_time_ms`, default 5min) reached. Either raise it or break the work into smaller subgraphs.

### `MemoryWriterMissingError: Reflection node "X" requires a memoryWriter`

A graph contains a `reflection` node but `GraphRunnerOptions.memoryWriter` is unset. Wire one up — see [Reflection pattern](/docs/patterns/reflection/).

### `MCPServerNotFoundError: MCP server "X" not registered`

A node declared `tools: [{ type: 'mcp', server_id: 'X' }]` but the server isn't in the `MCPServerRegistry`. Either call `registerDefaultMCPServers()` (gives you `web-search` and `fetch`) or register your custom servers explicitly.

### `MCPAccessDeniedError`

The agent doesn't have permission for the MCP server in its `tools` declaration. Check the `allowed_agent_ids` field on the server's registry entry.

## The "silently wrong" gotchas

These don't throw — your workflow just behaves differently than you expect.

### `memoryRetriever` wired but never called

The retriever is **per-node opt-in**. It only fires for nodes that declare a `memory_query` directive. Without that, the option is silently a no-op.

```typescript
// ❌ memoryRetriever wired but nothing pulls from it
new GraphRunner(graph, state, { memoryRetriever });

// ✅ Researcher node declares memory_query — retriever fires
{
  id: 'researcher',
  type: 'agent',
  agent_id: RESEARCHER_ID,
  read_keys: ['goal'],
  write_keys: ['notes'],
  memory_query: { tags: ['lesson'], max_facts: 10 },
}
```

### Reflection extracted facts but no future runs see them

Almost always one of:
1. The reflection node's `tags` and the consuming node's `memory_query.tags` don't match.
2. The `memoryRetriever` adapter doesn't pass `query.tags` through to `retrieveMemory()` (must include `tags: query.tags ?? []`).
3. `InMemoryMemoryStore` was instantiated **per run** instead of once for the process — every run starts cold. Use `DrizzleMemoryStore` for persistence across runs.

### Agent ignores `## Relevant Memory` in its prompt

The retrieved-memory section is rendered as `<memory>...</memory>` inside the system prompt, but the agent's own system prompt has to tell it to use it. Models won't infer the purpose of that block — write something like `"When the prompt contains a '## Relevant Memory' section with prior lessons, honour them..."` in the agent system prompt.

### Workflow runs forever or hits `max_iterations`

A cyclic graph is looping on the same nodes. Common causes:
- Supervisor's `completion_condition` never satisfies.
- Conditional edge always routes back to a previous node.
- `max_iterations` on supervisor/evolution/annealing is too high relative to the actual convergence.

Use `runner.on('supervisor:routed', ...)` or the OTel `supervisor.route` span to see what's deciding to loop.

## Where to dig deeper

- [Error Handling](/docs/concepts/error-handling/) — full error catalogue and propagation rules.
- [Observability / Tracing](/docs/observability/tracing/) — wire OpenTelemetry to see what's actually happening.
- [Operations / Deployment](/docs/operations/deployment/) — deployment-time errors and Postgres setup.
- [Workflow State](/docs/concepts/workflow-state/) — what's in `state.memory` vs `state.supervisor_history` vs the event log.
