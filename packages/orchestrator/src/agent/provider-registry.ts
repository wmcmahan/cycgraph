/**
 * LLM Provider Registry
 *
 * A runtime registry for Vercel AI SDK-compatible LLM providers.
 * Any provider can be registered with a resolver function and a list
 * of known model identifiers for validation and auto-inference.
 *
 * Built-in OpenAI and Anthropic providers are pre-registered via
 * {@link registerBuiltInProviders}. API keys are resolved lazily at
 * model-resolution time (not at registration time).
 *
 * @module agent/provider-registry
 */

import type { LanguageModel } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import {
  OPENAI_MODELS,
  ANTHROPIC_MODELS,
  DEFAULT_AGENT_PROVIDER,
} from './constants.js';
import { UnsupportedProviderError } from './agent-factory/errors.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('provider.registry');

/**
 * A callable that resolves a model ID to a {@link LanguageModel} instance.
 *
 * This matches the signature returned by AI SDK provider factories
 * (e.g. `createOpenAI()`, `createGroq()`, `createOllama()`).
 */
export type LanguageModelFactory = (modelId: string) => LanguageModel;

/** Options for registering a provider. */
export interface ProviderOptions {
  /** Known model identifiers this provider supports. */
  models: string[];
  /**
   * When true, an unknown model (not in {@link models}) is passed through to
   * the factory instead of throwing. Use for providers whose model space is
   * open-ended — e.g. Ollama, where model ids are arbitrary local tags. Curated
   * cloud providers (OpenAI, Anthropic) leave this false to fail fast on typos.
   * Defaults to false.
   */
  allowUnknownModels?: boolean;
}

/** Internal storage for a registered provider. */
interface ProviderRegistration {
  /** Resolves a model ID to a LanguageModel instance. */
  factory: LanguageModelFactory;
  /** Known model identifiers this provider supports. */
  models: string[];
  /** Whether unknown models pass through instead of throwing. */
  allowUnknownModels: boolean;
}

/**
 * Runtime registry for LLM providers.
 *
 * Consumers register providers by name with a factory function and
 * known model list. The {@link AgentFactory} delegates model resolution
 * to this registry, eliminating the hardcoded provider switch.
 */
export class ProviderRegistry {
  private providers = new Map<string, ProviderRegistration>();

  /**
   * Register a provider by name. Overwrites if already registered.
   *
   * @param name - Provider name (e.g. `'groq'`, `'ollama'`).
   * @param factory - Callable that resolves a model ID to a LanguageModel.
   * @param options - Additional options including known model identifiers.
   */
  register(name: string, factory: LanguageModelFactory, options: ProviderOptions): void {
    this.providers.set(name, {
      factory,
      models: options.models,
      allowUnknownModels: options.allowUnknownModels ?? false,
    });
  }

  /** Check if a provider is registered. */
  has(name: string): boolean {
    return this.providers.has(name);
  }

  /** Remove a registered provider. Returns true if it existed. */
  unregister(name: string): boolean {
    return this.providers.delete(name);
  }

  /** List all registered provider names. */
  listProviders(): string[] {
    return [...this.providers.keys()];
  }

  /**
   * Resolve a LanguageModel for the given provider and model ID.
   *
   * Logs a warning if the model is not in the provider's known model
   * list, but does not block — this allows using new models before
   * the list is updated.
   *
   * @throws {UnsupportedProviderError} If the provider is not registered.
   */
  resolveModel(providerName: string, modelId: string): LanguageModel {
    const registration = this.providers.get(providerName);
    if (!registration) {
      throw new UnsupportedProviderError(providerName);
    }
    if (!registration.models.includes(modelId)) {
      if (!registration.allowUnknownModels) {
        // Fail fast on an unknown model rather than letting it reach the
        // provider SDK, where a typo'd/decommissioned id is silently substituted
        // or errors mid-stream after real token spend. The agent config is
        // misconfigured; surface it loudly. Register genuinely-new models via
        // `addModel()`, or set `allowUnknownModels` for open-ended providers.
        throw new Error(
          `Unknown model "${modelId}" for provider "${providerName}". ` +
            `Known models: ${registration.models.join(', ')}. ` +
            `Fix the agent config or register it with registry.addModel("${providerName}", "${modelId}").`,
        );
      }
      // Open-ended provider (e.g. Ollama): pass through, but warn.
      logger.warn('unknown_model', { provider: providerName, modelId, known: registration.models });
    }
    return registration.factory(modelId);
  }

  /**
   * Check if a model is in the provider's known model list.
   *
   * @returns `true` if the provider is registered and knows the model.
   */
  supportsModel(providerName: string, modelId: string): boolean {
    const registration = this.providers.get(providerName);
    if (!registration) return false;
    return registration.models.includes(modelId);
  }

  /**
   * Add a model name to an existing provider's known model list.
   *
   * @throws {UnsupportedProviderError} If the provider is not registered.
   */
  addModel(providerName: string, modelId: string): void {
    const registration = this.providers.get(providerName);
    if (!registration) {
      throw new UnsupportedProviderError(providerName);
    }
    if (!registration.models.includes(modelId)) {
      registration.models.push(modelId);
    }
  }

  /**
   * Infer provider name from model ID using exact match against
   * registered model lists.
   *
   * @returns The provider name, or default provider if no match is found.
   */
  inferProvider(modelId: string): string {
    for (const [name, reg] of this.providers) {
      if (reg.models.includes(modelId)) {
        return name;
      }
    }
    return DEFAULT_AGENT_PROVIDER;
  }
}

/**
 * Register the built-in OpenAI and Anthropic providers.
 *
 * API keys are resolved lazily at model-resolution time so that
 * registration never throws. This preserves the existing error
 * behavior where missing keys are caught when `getModel()` is called.
 */
export function registerBuiltInProviders(registry: ProviderRegistry): void {
  registry.register('openai', (modelId: string) => {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY environment variable is not set');
    }
    return createOpenAI({ apiKey })(modelId);
  }, { models: [...OPENAI_MODELS] });

  registry.register('anthropic', (modelId: string) => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY environment variable is not set');
    }
    return createAnthropic({ apiKey })(modelId);
  }, { models: [...ANTHROPIC_MODELS] });
}

/** Create a ProviderRegistry with built-in providers pre-registered. */
export function createProviderRegistry(): ProviderRegistry {
  const registry = new ProviderRegistry();
  registerBuiltInProviders(registry);
  return registry;
}
