---
"@cycgraph/orchestrator": patch
"@cycgraph/context-engine": patch
---

Bring the built-in model catalog up to the November 2026 lineups. New entries in the known-model lists and pricing table: Claude Haiku 5.5 (`claude-haiku-5-5`, $0.10 / $0.50, cache reads $0.01), GPT-6.1 Terra (`gpt-6.1-terra`, $1 / $5), the GPT-5.6 and GPT-5.4 lines plus GPT-5.5, Gemini 4 Argon (`gemini-4-argon`, $2 / $10 promotional) and Gemini 3.1 Flash-Lite, Mistral Large 4 (`mistral-large-4`, $0.70 / $2.10), and the current Ollama families (`qwen3`, `qwen3.5`, `qwen3.6`, `qwen3-coder`, `gemma4`, `gpt-oss`). Claude Sonnet 5.5 cache reads now bill at the published $0.10 instead of the 10% default. The context engine gives Haiku 5.5 its 1M window, Qwen 3.6 its 256K window, and treats Gemma 4 as a tabular-capable 128K model instead of the 8K JSON-only Gemma profile.
