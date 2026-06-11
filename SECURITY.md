# Security Policy

cycgraph is an agentic orchestration engine that executes LLM-driven workflows with access to tools, external data, and user state. We take security seriously and welcome responsible disclosure.

## Supported versions

Security fixes are backported to the latest minor release line of each published package:

| Package | Supported |
| --- | --- |
| `@cycgraph/orchestrator` | Latest minor |
| `@cycgraph/orchestrator-postgres` | Latest minor |
| `@cycgraph/memory` | Latest minor |
| `@cycgraph/context-engine` | Latest minor |

Pre-release versions (`-beta`, `-alpha`) receive fixes on a best-effort basis only.

## Reporting a vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Report privately via either channel:

- GitHub Security Advisory: <https://github.com/wmcmahan/cycgraph/security/advisories/new> (preferred)
- Email: `mcmahanwill@gmail.com` with subject prefix `[cycgraph security]`

Please include:

1. Affected package(s) and version(s)
2. A description of the vulnerability and its impact
3. Reproduction steps or a proof-of-concept
4. Any suggested mitigation

We aim to:

- Acknowledge your report within **3 business days**
- Provide an initial assessment within **7 business days**
- Ship a fix or coordinate disclosure within **30 days** for high-severity issues

If you would like credit in the release notes, please say so in your report.

## Threat model

cycgraph is designed around a **Zero Trust** posture between the engine and the agents it runs. Agents are treated as **untrusted** — they may be misaligned, prompt-injected, or compromised by adversarial tool output. The engine enforces the following invariants:

1. **No host execution.** Agents have no access to `fs`, `child_process`, or any host capability. Tool execution flows exclusively through the MCP layer, which runs in sandboxed containers.
2. **Permission-scoped state.** Each agent receives only the memory keys declared in its `read_keys`. Writes are filtered by `write_keys` before reducers apply them. The wildcard `'*'` grants full access and should be used only for trusted system agents.
3. **Taint tracking.** Strings returned by external MCP tools are tagged with provenance metadata in `_taint_registry`. Derived outputs inherit taint via `propagateDerivedTaint`. Edge conditions and downstream agents can branch on taint state to refuse to forward untrusted data into privileged sinks.
4. **Schema-first boundaries.** All inputs and outputs at module boundaries are validated with Zod. Unknown action types are rejected by default (deny-by-default in `validateAction`).
5. **Budget enforcement.** Every run has token and cost ceilings. Exceeding them raises `BudgetExceededError` and the workflow fails closed.
6. **No raw secrets to agents.** API keys are injected into the MCP server process environment, not passed through agent prompts or state.
7. **Bounded memory.** Oversized or non-serializable memory updates are rejected and recorded in `state.memory_drops` plus a `memory:dropped` stream event — they never enter durable state.

## Known non-goals

Behaviors that are **outside the engine's threat model**:

- The engine does not defend against a malicious operator with write access to the `agents` registry, the MCP server registry, or the database. These are trusted control surfaces.
- The engine does not defend against vulnerabilities in third-party MCP servers — host them in isolated environments.
- The Workflow Architect (`@cycgraph/orchestrator/architect`) generates graph definitions from natural-language prompts. Generated graphs are **never auto-executed**; a human must explicitly publish them.
- LLM jailbreaks, hallucinations, or prompt injections that stay within the agent's declared permissions are alignment concerns, not engine vulnerabilities. Use evals, taint policies, and budget caps to constrain blast radius.

## Hardening checklist for operators

When deploying cycgraph in production:

- [ ] Run MCP servers in isolated containers with no host filesystem mounts
- [ ] Set per-workflow `max_token_budget` and `budget_usd` ceilings
- [ ] Set per-workflow `max_execution_time_ms` and `max_iterations`
- [ ] Configure `RetentionService` to purge old runs and events
- [ ] Enable OpenTelemetry tracing and alert on `workflow:failed` / `memory:dropped` / `budget:threshold_reached` events
- [ ] Pin agent `read_keys` and `write_keys` narrowly — avoid `'*'`
- [ ] Run the eval harness in CI before publishing agent or graph changes
- [ ] Review the `mcp_servers` registry — only allow MCP servers your agents need

## Public discussion

After a fix is published, we coordinate disclosure timing with the reporter. Default policy: a brief advisory at the patched release, with full technical details 30 days later to give downstream consumers time to upgrade.
