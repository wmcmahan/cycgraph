---
title: Custom LLM Providers
description: Register Groq, Ollama, or other providers.
---

cycgraph ships with **OpenAI** and **Anthropic** pre-registered. To use a different LLM provider (Groq, Ollama, Google, Mistral, etc.), register it at startup.

## Quick start

Create a provider registry and scope it into the run. The built-in providers are included automatically. `run()` takes a `providers` option, and the explicit `GraphRunner` takes the same option under `GraphRunnerOptions`.

```typescript
import { createProviderRegistry, run } from '@cycgraph/orchestrator';

const providers = createProviderRegistry(); // includes openai + anthropic

const result = await run(workflow, { goal: '...' }, { providers });
```

That's it for the defaults. Agents using `provider: 'openai'` or `provider: 'anthropic'` will resolve correctly as long as the corresponding `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` environment variable is set. The older `configureProviderRegistry(providers)` global is deprecated in favor of the `providers` option.

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

The simplest way to add Ollama support is the built-in `registerOllamaProvider` helper. It takes the registry, a **model factory**, and optional overrides. Ollama exposes an OpenAI-compatible API, so `@ai-sdk/openai` works as the factory:

```typescript
import { registerOllamaProvider } from '@cycgraph/orchestrator';
import { createOpenAI } from '@ai-sdk/openai';

registerOllamaProvider(
  providers,
  ({ baseURL }) => {
    const provider = createOpenAI({ baseURL: `${baseURL}/v1`, apiKey: 'ollama' });
    return (modelId) => provider.chat(modelId);
  },
  {
    models: ['llama3.2', 'mistral', 'codellama'],
    // baseUrl defaults to 'http://localhost:11434'
  },
);
```

The base URL is resolved from `baseUrl` → the `OLLAMA_BASE_URL` env var → `http://localhost:11434`. If you prefer the dedicated Ollama provider package, you can skip the helper and register it manually:

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

Reference your provider by name in the agent's `provider` field. The facade infers the provider only from well-known model prefixes, so a custom-provider model names its provider explicitly:

```typescript
const fastResearcher = agent({
  name: 'Fast Researcher',
  model: 'llama-3.3-70b-versatile',
  provider: 'groq',
  instructions: 'You are a research specialist...',
});
```

## Provider options

Some providers support additional options such as extended thinking or structured output modes. Pass these via `providerOptions` on the agent:

```typescript
const deepThinker = agent({
  name: 'Deep Thinker',
  model: 'claude-opus-4-8',
  provider: 'anthropic',
  providerOptions: {
    thinking: {
      type: 'enabled',
      budgetTokens: 12000,
    },
  },
  instructions: 'You solve complex problems step by step...',
});
```

## Provider inference

There are two layers of inference, and they behave differently.

The facade's `agent()` infers the provider at authoring time from well-known model-name prefixes: `claude-*` resolves to Anthropic, `gpt-*` and `o1`/`o3`-style names to OpenAI. A model it does not recognize, such as a Groq or Ollama model, has no known prefix, so `agent()` throws unless you pass `provider` explicitly. This is why the custom-provider examples above name their provider.

The engine has a second, broader inference used when an agent config reaches the registry without a `provider` field, for example one loaded from a database rather than authored with `agent()`. It matches the `model` against each registered provider's known model list, and falls back to `anthropic` when nothing matches.

```typescript
// provider resolves to 'groq' because 'llama-3.3-70b-versatile'
// is in the groq provider's registered model list
registry.register({
  name: 'Inferred Provider Agent',
  model: 'llama-3.3-70b-versatile',
  // provider omitted — the registry infers it from the model list
  systemPrompt: '...',
});
```

To register new model names at runtime without re-registering the entire provider:

```typescript
providers.addModel('openai', 'gpt-5');
```

:::note
The model list is **advisory, not a strict allowlist**. If you use a model ID that isn't in the known list, the engine logs a warning but still forwards the request to the provider. This means newly released models work immediately. You just won't get provider inference for them until they're added.
:::

## Built-in models

These models are pre-registered and available out of the box:

| Provider | Models |
|----------|--------|
| `openai` | `gpt-4o`, `gpt-4o-mini`, `gpt-4-turbo`, `gpt-4`, `o1-preview`, `o1-mini`, `o3`, `o3-mini`, `o4-mini` |
| `anthropic` | `claude-opus-4-8`, `claude-sonnet-4-6`, `claude-3-5-sonnet-20241022`, `claude-3-5-haiku-20241022`, `claude-3-opus-20240229` |
| `ollama` | Any local model (register via `registerOllamaProvider()` with your model list) |

## Next steps

- [Agents](/docs/concepts/agents/): how agents reference providers and models
- [Tools & MCP](/docs/concepts/tools-and-mcp/): give agents external capabilities
- [Cost & Budget Tracking](/docs/concepts/cost-tracking/): per-model pricing and budget enforcement
