---
title: Custom LLM Providers
description: Register Groq, Ollama, or other providers.
---

cycgraph ships with **OpenAI** and **Anthropic** pre-registered, plus zero-dependency helpers for **Google Gemini**, **Ollama**, and a catalog of **OpenAI-compatible hosts** (Groq, DeepSeek, xAI, OpenRouter, Mistral, Together, Fireworks, Cerebras). Anything else registers with a few lines at startup.

## Quick start

Create a provider registry and scope it into the run. The built-in providers are included automatically. `run()` takes a `providers` option, and the explicit `GraphRunner` takes the same option under `GraphRunnerOptions`.

```typescript
import { createProviderRegistry, run } from '@cycgraph/orchestrator';

const providers = createProviderRegistry();

const result = await run(workflow, { goal: '...' }, { providers });
```

That's it for the defaults. Agents using `provider: 'openai'` or `provider: 'anthropic'` will resolve correctly as long as the corresponding `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` environment variable is set. The older `configureProviderRegistry(providers)` global is deprecated in favor of the `providers` option.

## OpenAI-compatible providers

Most hosted providers expose an OpenAI-compatible API, and cycgraph ships a catalog of them: Groq, DeepSeek, xAI, OpenRouter, Mistral, Together, Fireworks, and Cerebras. One call registers them all. The helper takes an injected factory so the engine itself depends on no provider SDK; `@ai-sdk/openai-compatible` is the natural choice:

```typescript
import { registerOpenAICompatibleProviders } from '@cycgraph/orchestrator';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

registerOpenAICompatibleProviders(providers, ({ name, baseURL, apiKey }) =>
  (modelId) => createOpenAICompatible({ name, baseURL, apiKey }).chatModel(modelId),
);
```

API keys are read lazily from each provider's environment variable (`GROQ_API_KEY`, `DEEPSEEK_API_KEY`, `XAI_API_KEY`, `OPENROUTER_API_KEY`, `MISTRAL_API_KEY`, `TOGETHER_API_KEY`, `FIREWORKS_API_KEY`, `CEREBRAS_API_KEY`) when a model is first resolved. Agents then reference the provider by name:

```typescript
const fast = agent({
  name: 'Fast Researcher',
  model: 'llama-3.3-70b-versatile',
  provider: 'groq',
  instructions: '...',
});
```

Pass `providers: ['groq']` to register a subset, or `extra` to add endpoints the catalog does not carry, such as a corporate gateway or a self-hosted vLLM server:

```typescript
registerOpenAICompatibleProviders(providers, factory, {
  extra: [{
    name: 'corp-gateway',
    baseURL: 'https://llm.corp.internal/v1',
    apiKeyEnv: 'CORP_GATEWAY_API_KEY',
    models: ['internal-model-1'],
  }],
});
```

## Adding a custom provider

For providers with their own SDK and wire format, use `providers.register()` with three arguments: a name, a factory function, and a list of known models.

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

Google has a built-in helper like Ollama's, since Gemini's native API carries thinking configs and cache-usage reporting that the OpenAI-compatible surface flattens. Inject `@ai-sdk/google` as the factory:

```typescript
import { registerGoogleProvider } from '@cycgraph/orchestrator';
import { createGoogleGenerativeAI } from '@ai-sdk/google';

registerGoogleProvider(providers, ({ apiKey }) => createGoogleGenerativeAI({ apiKey }));
```

The key is read lazily from `GOOGLE_GENERATIVE_AI_API_KEY`, falling back to `GEMINI_API_KEY`. The current Gemini lineup is pre-registered; pass `models` to add preview or tuned variants.

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

Some providers support additional options such as adaptive thinking or structured output modes. Pass these via `providerOptions` on the agent:

```typescript
const deepThinker = agent({
  name: 'Deep Thinker',
  model: 'claude-opus-5-5',
  provider: 'anthropic',
  providerOptions: {
    thinking: {
      type: 'adaptive',
    },
  },
  instructions: 'You solve complex problems step by step...',
});
```

Older Anthropic models before Claude 4.6 use a fixed thinking budget instead: `thinking: { type: 'enabled', budgetTokens: 12000 }`. Current models reject `budgetTokens`, so use `adaptive` unless you are pinned to an older model.

To control reasoning depth, prefer the first-class `effort` field over hand-written provider options: `agent({ effort: 'low' })` is provider-neutral, and the engine translates it to the right option for whichever provider runs the agent. See [EffortLevel](/docs/concepts/agents/#effortlevel). Reach for raw `providerOptions` when you need something `effort` does not cover.

## Provider inference

There are two layers of inference, and they behave differently.

The facade's `agent()` infers the provider at authoring time from well-known model-name prefixes: `claude-*` resolves to Anthropic, `gpt-*` and `o1`/`o3`-style names to OpenAI. A model it does not recognize, such as a Groq or Ollama model, has no known prefix, so `agent()` throws unless you pass `provider` explicitly. This is why the custom-provider examples above name their provider.

The engine has a second, broader inference used when an agent config reaches the registry without a `provider` field, for example one loaded from a database rather than authored with `agent()`. It matches the `model` against each registered provider's known model list, and falls back to `anthropic` when nothing matches.

```typescript
registry.register({
  name: 'Inferred Provider Agent',
  model: 'llama-3.3-70b-versatile',
  systemPrompt: '...',
});
```

To register new model names at runtime without re-registering the entire provider:

```typescript
providers.addModel('openai', 'gpt-5');
```

:::note
How an unknown model ID is handled depends on the provider. Curated providers (`openai`, `anthropic`, `google`, `deepseek`, `xai`) **fail fast** so a typo'd or decommissioned ID surfaces before any token spend; register a newly released model with `addModel()`. Open-ended providers (`ollama`, `openrouter`, `together`, `fireworks`, and the rotating host catalogs `groq`, `mistral`, `cerebras`) pass unknown IDs through with a warning, so new models there work immediately.
:::

## Built-in models

These models are pre-registered and available out of the box:

| Provider | Models |
|----------|--------|
| `openai` | `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`, `gpt-5.1`, `gpt-5`, `gpt-5-mini`, `gpt-5-nano`, and the GPT-4/o-series |
| `anthropic` | `claude-fable-5-1`, `claude-opus-5-5`, `claude-sonnet-5`, `claude-haiku-4-5`, and the Claude 4.x/5 legacy line |
| `google` | `gemini-3.8-flash` through `gemini-3.5-flash`, `gemini-3.5-flash-lite`, `gemini-3.1-pro-preview`, `gemini-2.5-flash-lite` |
| `groq` | `llama-3.3-70b-versatile`, `llama-3.1-8b-instant`, `openai/gpt-oss-120b`, `openai/gpt-oss-20b`, plus pass-through |
| `deepseek` | `deepseek-v4-pro`, `deepseek-flash` |
| `xai` | `grok-4.7`, `grok-4.6`, `grok-4.5`, `grok-4.3`, `grok-build-0.1` |
| `mistral` | `mistral-large-latest`, `mistral-medium-latest`, `mistral-small-latest`, `codestral-latest`, `ministral-8b-latest`, `ministral-3b-latest`, plus dated snapshots via pass-through |
| `cerebras` | `gpt-oss-120b`, `qwen-3.8-27b`, plus pass-through |
| `openrouter`, `together`, `fireworks` | Any model slug the host serves (pass-through) |
| `ollama` | Any local model (register via `registerOllamaProvider()` with your model list) |

## Managed deployment routes (Bedrock, Vertex, Azure)

Amazon Bedrock, Google Vertex AI, and Azure serve the same frontier models under enterprise billing and networking, so cycgraph treats them as **deployment routes, not separate providers**. Register them like any custom provider, using the platform's AI SDK package as the injected factory — for example `@ai-sdk/amazon-bedrock` with `providers.register('bedrock', ...)` and Bedrock's `anthropic.claude-opus-5-5`-style IDs. Pricing on these platforms is set by the platform, so load a rate card via `loadPricingTable()` if you enforce USD budgets there.

## Next steps

- [Agents](/docs/concepts/agents/): how agents reference providers and models
- [Tools & MCP](/docs/concepts/tools-and-mcp/): give agents external capabilities
- [Cost & Budget Tracking](/docs/concepts/cost-tracking/): per-model pricing and budget enforcement
