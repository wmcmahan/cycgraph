---
"@cycgraph/orchestrator": minor
---

Two new zero-dependency provider helpers expand the built-in surface. `registerOpenAICompatibleProviders` registers a catalog of eight OpenAI-compatible hosts (Groq, DeepSeek, xAI, OpenRouter, Mistral, Together, Fireworks, Cerebras) from one injected factory, with `providers` to select a subset and `extra` to add endpoints such as a corporate gateway; `registerGoogleProvider` wires Gemini natively so its thinking configs and cache-usage reporting survive. The known-model lists and pricing table are refreshed to the current frontier lineups (Claude Opus 5.5 / Fable 5.1, the GPT-6 and GPT-5 families, Gemini 3.x, Grok 4.x, DeepSeek V4, Mistral aliases), and `DEFAULT_AGENT_MODEL` moves from `claude-sonnet-4-6` to `claude-sonnet-5`.
