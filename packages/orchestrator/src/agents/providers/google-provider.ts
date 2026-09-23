/**
 * Google Gemini Provider Registration
 *
 * Convenience helper for registering Google's Gemini API as an LLM
 * provider in the orchestrator's {@link ProviderRegistry}.
 *
 * Takes an injected factory, so the orchestrator depends on no Google
 * SDK. The native `@ai-sdk/google` package is the natural choice — it
 * carries Gemini's thinking configs and cache-usage reporting that the
 * OpenAI-compatible surface flattens:
 *
 * ```typescript
 * import { createGoogleGenerativeAI } from '@ai-sdk/google';
 * registerGoogleProvider(registry, ({ apiKey }) => createGoogleGenerativeAI({ apiKey }));
 * ```
 *
 * @module agents/providers/google-provider
 */

import type { LanguageModel } from 'ai';
import type { ProviderRegistry } from './provider-registry.js';
import { GOOGLE_MODELS } from '../constants.js';
import { createLogger } from '../../observability/logger.js';

const logger = createLogger('provider.google');

/**
 * Factory function that creates a Gemini model resolver.
 *
 * Accepts the resolved `{ apiKey }` and returns a callable that resolves
 * a model ID to a {@link LanguageModel}. This matches the shape of
 * `createGoogleGenerativeAI()` from `@ai-sdk/google`.
 */
export type GoogleModelFactory = (config: { apiKey: string }) => (modelId: string) => LanguageModel;

/** Options for {@link registerGoogleProvider}. */
export interface GoogleProviderOptions {
  /**
   * Additional model IDs to register beyond the built-in
   * {@link GOOGLE_MODELS} list. Useful for preview or tuned models.
   */
  models?: string[];
}

/**
 * Register Google Gemini as a provider in the given {@link ProviderRegistry}.
 *
 * The API key is resolved lazily at model-resolution time (not at
 * registration time), matching the built-in OpenAI and Anthropic
 * providers: `GOOGLE_GENERATIVE_AI_API_KEY` first (the `@ai-sdk/google`
 * convention), then `GEMINI_API_KEY` (Google's own docs convention).
 *
 * @param registry - The provider registry to register with.
 * @param createGoogle - Factory that creates a Gemini model resolver.
 * @param options - Optional configuration overrides.
 */
export function registerGoogleProvider(
  registry: ProviderRegistry,
  createGoogle: GoogleModelFactory,
  options: GoogleProviderOptions = {},
): void {
  const models = [...GOOGLE_MODELS, ...(options.models ?? [])];

  registry.register('google', (modelId: string) => {
    const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('GOOGLE_GENERATIVE_AI_API_KEY environment variable is not set');
    }
    logger.info('resolving_google_model', { modelId });
    return createGoogle({ apiKey })(modelId);
  }, { models });
}
