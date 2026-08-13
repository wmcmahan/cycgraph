/**
 * Ollama Provider Registration
 *
 * Convenience helper for registering a local Ollama instance as an
 * LLM provider in the orchestrator's {@link ProviderRegistry}.
 *
 * Takes an injected factory, so the orchestrator depends on no Ollama or
 * OpenAI-compatible SDK:
 *
 * ```typescript
 * import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
 * registerOllamaProvider(registry, ({ baseURL }) =>
 *   (modelId) => createOpenAICompatible({ name: 'ollama', baseURL, apiKey: 'ollama' }).chatModel(modelId),
 * );
 *
 * import { createOllama } from 'ollama-ai-provider-v2';
 * registerOllamaProvider(registry, ({ baseURL }) => createOllama({ baseURL }));
 * ```
 *
 * @module agents/providers/ollama-provider
 */

import type { LanguageModel } from 'ai';
import type { ProviderRegistry } from './provider-registry.js';
import { OLLAMA_MODELS } from '../constants.js';
import { createLogger } from '../../observability/logger.js';

const logger = createLogger('provider.ollama');

/** Default Ollama server URL. */
const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434';

/**
 * Factory function that creates an Ollama model resolver.
 *
 * Accepts a `{ baseURL }` config and returns a callable that resolves
 * a model ID to a {@link LanguageModel}. This matches the shape of
 * both `createOllama()` from `ollama-ai-provider-v2` and custom
 * wrappers around `@ai-sdk/openai-compatible`.
 */
export type OllamaModelFactory = (config: { baseURL: string }) => (modelId: string) => LanguageModel;

/** Options for {@link registerOllamaProvider}. */
export interface OllamaProviderOptions {
  /**
   * Ollama server base URL.
   *
   * Resolution order: this option → `OLLAMA_BASE_URL` env var →
   * `http://localhost:11434`.
   */
  baseUrl?: string;

  /**
   * Additional model IDs to register beyond the built-in
   * {@link OLLAMA_MODELS} list. Useful for custom or fine-tuned models.
   */
  models?: string[];
}

/**
 * Register Ollama as a provider in the given {@link ProviderRegistry}.
 *
 * The base URL is resolved lazily at model-resolution time (not at
 * registration time), matching the pattern used by the built-in
 * OpenAI and Anthropic providers for API keys.
 *
 * @param registry - The provider registry to register with.
 * @param createOllama - Factory that creates an Ollama model resolver.
 * @param options - Optional configuration overrides.
 */
export function registerOllamaProvider(
  registry: ProviderRegistry,
  createOllama: OllamaModelFactory,
  options: OllamaProviderOptions = {},
): void {
  const models = [...OLLAMA_MODELS, ...(options.models ?? [])];

  registry.register('ollama', (modelId: string) => {
    const baseURL = options.baseUrl
      ?? process.env.OLLAMA_BASE_URL
      ?? DEFAULT_OLLAMA_BASE_URL;

    logger.info('resolving_ollama_model', { modelId, baseURL });
    return createOllama({ baseURL })(modelId);
    // Ollama model ids are arbitrary local tags (e.g. `my-finetune:latest`), so
    // the known list is only a hint — unknown models must pass through.
  }, { models, allowUnknownModels: true });
}
