---
title: Custom LLM Providers
description: Register Groq, Ollama, or other providers.
---

cycgraph ships with **OpenAI** and **Anthropic** pre-registered. To use a different LLM provider (Groq, Ollama, Google, Mistral, etc.), register it at startup.

## Quick start

Two steps: create a provider registry and wire it into the engine. The built-in providers are included automatically.

```typescript
import {
  createProviderRegistry,
  configureProviderRegistry,
} from '@cycgraph/orchestrator';

const providers = createProviderRegistry(); // includes openai + anthropic
configureProviderRegistry(providers);
```

That's it for the defaults. Agents using `provider: 'openai'` or `provider: 'anthropic'` will resolve correctly as long as the corresponding `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` environment variable is set.

## Adding a custom provider

Use `providers.register()` with three arguments: a name, a factory function, and a list of known models.

### Groq

```typescript
import { createGroq } from '@ai-sdk/groq';

const groq = createGroq({ apiKey: process.env.GROQ_API_KEY });

providers.register('groq', (modelId) => groq(modelId), {
  models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768'],
});
```

### Ollama (local)

The simplest way to add Ollama support is the built-in helper:

```typescript
import { registerOllamaProvider } from '@cycgraph/orchestrator';

registerOllamaProvider(providers, {
  models: ['llama3.2', 'mistral', 'codellama'],
  // baseURL defaults to 'http://localhost:11434/api'
});
```

Under the hood this uses `@ai-sdk/openai` with Ollama's OpenAI-compatible endpoint. If you prefer the dedicated Ollama provider package, you can register it manually:

```typescript
import { createOllama } from 'ollama-ai-provider-v2';

const ollama = createOllama({ baseURL: 'http://localhost:11434/api' });

providers.register('ollama', (modelId) => ollama(modelId), {
  models: ['llama3.2', 'mistral', 'codellama'],
});
```

### Google

```typescript
import { createGoogleGenerativeAI } from '@ai-sdk/google';

const google = createGoogleGenerativeAI({ apiKey: process.env.GOOGLE_API_KEY });

providers.register('google', (modelId) => google(modelId), {
  models: ['gemini-2.5-pro', 'gemini-2.5-flash'],
});
```

## Using a custom provider in agents

Reference your provider by name in the agent config:

```typescript
const FAST_AGENT = registry.register({
  name: 'Fast Researcher',
  model: 'llama-3.3-70b-versatile',
  provider: 'groq',
  system_prompt: 'You are a research specialist...',
  tools: [],
  permissions: { read_keys: ['goal'], write_keys: ['notes'] },
});
```

## Provider options

Some providers support additional options (extended thinking, structured output modes, etc.). Pass these via `provider_options` on the agent config:

```typescript
const THINKING_AGENT = registry.register({
  name: 'Deep Thinker',
  model: 'claude-opus-4-8',
  provider: 'anthropic',
  provider_options: {
    thinking: {
      type: 'enabled',
      budgetTokens: 12000,
    },
  },
  system_prompt: 'You solve complex problems step by step...',
  tools: [],
  permissions: { read_keys: ['*'], write_keys: ['*'] },
});
```

## Provider inference

If an agent config omits the `provider` field, the engine infers it by matching the `model` against each provider's known model list. If no match is found, it defaults to `anthropic`.

```typescript
// provider is inferred as 'groq' because 'llama-3.3-70b-versatile'
// was registered in the groq provider's model list
const AGENT = registry.register({
  name: 'Inferred Provider Agent',
  model: 'llama-3.3-70b-versatile',
  // provider: omitted — inferred automatically
  system_prompt: '...',
  tools: [],
  permissions: { read_keys: ['*'], write_keys: ['*'] },
});
```

To register new model names at runtime without re-registering the entire provider:

```typescript
providers.addModel('openai', 'gpt-5');
```

:::note
The model list is **advisory, not a strict allowlist**. If you use a model ID that isn't in the known list, the engine logs a warning but still forwards the request to the provider. This means newly released models work immediately — you just won't get provider inference for them until they're added.
:::

## Built-in models

These models are pre-registered and available out of the box:

| Provider | Models |
|----------|--------|
| `openai` | `gpt-4o`, `gpt-4o-mini`, `gpt-4-turbo`, `gpt-4`, `o1-preview`, `o1-mini`, `o3`, `o3-mini`, `o4-mini` |
| `anthropic` | `claude-opus-4-8`, `claude-sonnet-4-6`, `claude-3-5-sonnet-20241022`, `claude-3-5-haiku-20241022`, `claude-3-opus-20240229` |
| `ollama` | Any local model (register via `registerOllamaProvider()` with your model list) |

## Next steps

- [Agents](/docs/concepts/agents/) — how agents reference providers and models
- [Tools & MCP](/docs/concepts/tools-and-mcp/) — give agents external capabilities
- [Cost & Budget Tracking](/docs/concepts/cost-tracking/) — per-model pricing and budget enforcement
