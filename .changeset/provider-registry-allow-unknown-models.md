---
"@cycgraph/orchestrator": minor
---

Provider registry: support open-ended providers via an `allowUnknownModels` flag. Curated cloud providers (OpenAI, Anthropic) keep failing fast on an unregistered model id — a typo'd or decommissioned id throws with guidance to fix the agent config or call `addModel()`, rather than being silently substituted by the provider SDK. Providers whose model space is open-ended (e.g. Ollama, where model ids are arbitrary local tags) can register with `allowUnknownModels: true` to pass unknown ids through (with a warning) instead of throwing.
