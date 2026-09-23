/**
 * OpenAI-Compatible Provider Registration
 *
 * Convenience helper for registering hosted providers that expose an
 * OpenAI-compatible chat completions API (Groq, DeepSeek, xAI,
 * OpenRouter, and any custom endpoint) in the orchestrator's
 * {@link ProviderRegistry}.
 *
 * Takes an injected factory, so the orchestrator depends on no provider
 * SDK:
 *
 * ```typescript
 * import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
 * registerOpenAICompatibleProviders(registry, ({ name, baseURL, apiKey }) =>
 *   (modelId) => createOpenAICompatible({ name, baseURL, apiKey }).chatModel(modelId),
 * );
 *
 * import { createOpenAI } from '@ai-sdk/openai';
 * registerOpenAICompatibleProviders(registry, ({ baseURL, apiKey }) =>
 *   (modelId) => createOpenAI({ baseURL, apiKey })(modelId),
 * );
 * ```
 *
 * @module agents/providers/openai-compatible
 */

import type { LanguageModel } from 'ai';
import type { ProviderRegistry } from './provider-registry.js';
import { CEREBRAS_MODELS, DEEPSEEK_API_MODELS, GROQ_MODELS, MISTRAL_MODELS, XAI_MODELS } from '../constants.js';
import { createLogger } from '../../observability/logger.js';

const logger = createLogger('provider.openai-compatible');

/** One OpenAI-compatible provider endpoint the registry can be pointed at. */
export interface OpenAICompatibleProviderSpec {
  /** Provider name agents reference (e.g. `'groq'`). */
  name: string;
  /** Base URL of the provider's OpenAI-compatible API. */
  baseURL: string;
  /** Environment variable the API key is read from at resolution time. */
  apiKeyEnv: string;
  /** Known model identifiers for provider inference and validation. */
  models: string[];
  /**
   * Pass unknown model ids through to the factory instead of throwing.
   * Set for providers whose catalog is open-ended or rotates faster than
   * this list (OpenRouter's `vendor/model` slugs, Groq's hosted lineup).
   */
  allowUnknownModels?: boolean;
}

/**
 * Factory function that creates a model resolver for one provider.
 *
 * Accepts the resolved `{ name, baseURL, apiKey }` and returns a callable
 * that resolves a model ID to a {@link LanguageModel}. This matches thin
 * wrappers around `@ai-sdk/openai-compatible` and `createOpenAI` with a
 * `baseURL` override.
 */
export type OpenAICompatibleModelFactory = (
  config: { name: string; baseURL: string; apiKey: string },
) => (modelId: string) => LanguageModel;

/**
 * Built-in catalog of OpenAI-compatible providers.
 *
 * OpenRouter, Together, and Fireworks front open-ended model spaces, so
 * they carry no known-model list and pass everything through.
 */
export const OPENAI_COMPATIBLE_PROVIDERS: readonly OpenAICompatibleProviderSpec[] = [
  {
    name: 'groq',
    baseURL: 'https://api.groq.com/openai/v1',
    apiKeyEnv: 'GROQ_API_KEY',
    models: GROQ_MODELS,
    allowUnknownModels: true,
  },
  {
    name: 'deepseek',
    baseURL: 'https://api.deepseek.com',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    models: DEEPSEEK_API_MODELS,
  },
  {
    name: 'xai',
    baseURL: 'https://api.x.ai/v1',
    apiKeyEnv: 'XAI_API_KEY',
    models: XAI_MODELS,
  },
  {
    name: 'openrouter',
    baseURL: 'https://openrouter.ai/api/v1',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    models: [],
    allowUnknownModels: true,
  },
  {
    name: 'mistral',
    baseURL: 'https://api.mistral.ai/v1',
    apiKeyEnv: 'MISTRAL_API_KEY',
    models: MISTRAL_MODELS,
    allowUnknownModels: true,
  },
  {
    name: 'together',
    baseURL: 'https://api.together.xyz/v1',
    apiKeyEnv: 'TOGETHER_API_KEY',
    models: [],
    allowUnknownModels: true,
  },
  {
    name: 'fireworks',
    baseURL: 'https://api.fireworks.ai/inference/v1',
    apiKeyEnv: 'FIREWORKS_API_KEY',
    models: [],
    allowUnknownModels: true,
  },
  {
    name: 'cerebras',
    baseURL: 'https://api.cerebras.ai/v1',
    apiKeyEnv: 'CEREBRAS_API_KEY',
    models: CEREBRAS_MODELS,
    allowUnknownModels: true,
  },
];

/** Options for {@link registerOpenAICompatibleProviders}. */
export interface OpenAICompatibleProviderOptions {
  /**
   * Register only these providers from the built-in catalog. Omitting it
   * registers the whole catalog.
   */
  providers?: string[];
  /**
   * Additional endpoints to register beyond the built-in catalog
   * (e.g. a corporate gateway or self-hosted vLLM). A spec whose `name`
   * collides with a catalog entry replaces it.
   */
  extra?: OpenAICompatibleProviderSpec[];
}

/**
 * Register OpenAI-compatible providers in the given {@link ProviderRegistry}.
 *
 * API keys are resolved lazily at model-resolution time (not at
 * registration time), matching the built-in OpenAI and Anthropic
 * providers: registration never throws, a missing key surfaces when the
 * first model is resolved.
 *
 * @param registry - The provider registry to register with.
 * @param createModel - Factory that creates a model resolver per provider.
 * @param options - Optional catalog subset and additional endpoints.
 */
export function registerOpenAICompatibleProviders(
  registry: ProviderRegistry,
  createModel: OpenAICompatibleModelFactory,
  options: OpenAICompatibleProviderOptions = {},
): void {
  const catalogNames = OPENAI_COMPATIBLE_PROVIDERS.map((spec) => spec.name);
  for (const name of options.providers ?? []) {
    // Fail fast on a name outside the catalog: a typo ('grok' for 'xai')
    // would otherwise register nothing and surface much later as an
    // unrelated UnsupportedProviderError at model-resolution time.
    if (!catalogNames.includes(name)) {
      throw new Error(
        `Unknown OpenAI-compatible provider "${name}". Catalog: ${catalogNames.join(', ')}. ` +
          'Register a non-catalog endpoint via options.extra instead.',
      );
    }
  }

  const specs = new Map<string, OpenAICompatibleProviderSpec>();
  for (const spec of OPENAI_COMPATIBLE_PROVIDERS) {
    if (options.providers === undefined || options.providers.includes(spec.name)) {
      specs.set(spec.name, spec);
    }
  }
  for (const spec of options.extra ?? []) {
    specs.set(spec.name, spec);
  }

  for (const spec of specs.values()) {
    registry.register(spec.name, (modelId: string) => {
      const apiKey = process.env[spec.apiKeyEnv];
      if (!apiKey) {
        throw new Error(`${spec.apiKeyEnv} environment variable is not set`);
      }
      logger.info('resolving_openai_compatible_model', { provider: spec.name, modelId });
      return createModel({ name: spec.name, baseURL: spec.baseURL, apiKey })(modelId);
    }, { models: [...spec.models], allowUnknownModels: spec.allowUnknownModels ?? false });
  }
}
