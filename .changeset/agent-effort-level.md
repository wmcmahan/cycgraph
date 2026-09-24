---
"@cycgraph/orchestrator": minor
"@cycgraph/orchestrator-postgres": minor
---

Agent configs gain a provider-neutral `effort` field (`'low'` | `'medium'` | `'high'` | `'xhigh'` | `'max'`). The executor translates it to the provider's own option at call time — Anthropic `effort`, OpenAI `reasoningEffort` — for agent, supervisor, evaluator, and extractor calls alike; providers without an effort control ignore it, and an explicit value inside `providerOptions` still wins. The field threads through the authoring facade (`agent({ effort })`), both registries, graph bundles, and a new nullable `effort` column on the Postgres `agents` table (migration 0021). Bundling also stops dropping `max_output_tokens` from embedded agents, which `BundledAgentSchema` had been silently stripping.
