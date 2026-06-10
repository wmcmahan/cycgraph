/**
 * Agent Factory
 *
 * Manages agent configurations and language-model instances for the
 * executor layer. Responsibilities:
 *
 * - Load agent configs from a pluggable {@link AgentRegistry} (with TTL cache)
 * - Create and cache {@link LanguageModel} instances per provider:model pair
 * - Provide fallback configs with deny-all permissions when an agent is
 *   missing (non-transient) or no registry is configured
 * - Propagate transient errors (DB down, network) so callers can retry
 *
 * @module agent-factory/agent-factory
 */

import type { LanguageModel } from 'ai';
import { AgentConfigSchema, type AgentConfig } from '../types.js';
import { createLogger } from '../../utils/logger.js';
import {
  AGENT_CONFIG_CACHE_TTL_MS,
  DEFAULT_AGENT_MODEL,
  DEFAULT_AGENT_PROVIDER,
  DEFAULT_AGENT_TEMPERATURE,
  DEFAULT_AGENT_MAX_STEPS,
  DEFAULT_AGENT_SYSTEM_PROMPT,
  MAX_AGENT_CONFIG_CACHE_SIZE,
  FALLBACK_CONFIG_CACHE_TTL_MS,
} from '../constants.js';
import { isValidUUID } from './validation.js';
import { AgentNotFoundError, AgentLoadError, UnsupportedProviderError } from './errors.js';
import type { AgentRegistry } from '../../persistence/interfaces.js';
import { ProviderRegistry, createProviderRegistry } from '../provider-registry.js';

const logger = createLogger('agent.factory');

/** TTL-aware cache entry wrapping a cached value. */
interface CacheEntry<T> {
  /** The cached value. */
  value: T;
  /** Timestamp (ms) when the entry was created. */
  cachedAt: number;
  /** Fallback entries use a shorter TTL so DB recovery is detected sooner. */
  isFallback: boolean;
}

/**
 * Manages agent configurations and language-model instances.
 *
 * Use the singleton exported from `./index.ts` rather than constructing
 * directly — the singleton is wired into the executor and graph runner.
 */
export class AgentFactory {
  private modelCache = new Map<string, LanguageModel>();
  private configCache = new Map<string, CacheEntry<AgentConfig>>();
  private registry: AgentRegistry | null = null;
  private providerRegistry: ProviderRegistry = createProviderRegistry();
  /**
   * Whether a registry-configured-but-not-found agent falls back to the
   * generic deny-all default instead of throwing. Defaults to `false`
   * (fail closed): a typo'd or deleted `agent_id` must surface as an error,
   * not silently run a generic assistant that produces garbage output with
   * real token spend. Set `true` (via {@link setAllowDefaultFallback}) only
   * for tests / lightweight dev that intentionally reference unregistered IDs.
   */
  private allowDefaultFallback = false;

  /**
   * Configure the agent registry for database-backed agent loading.
   *
   * Call this once at startup. Without a registry, all agents use the
   * default config with deny-all permissions.
   *
   * @param registry - The persistence backend for agent configs.
   */
  setRegistry(registry: AgentRegistry): void {
    this.registry = registry;
  }

  /**
   * Configure a custom provider registry.
   * Clears the model cache since providers may have changed.
   *
   * @param providerRegistry - The provider registry to use.
   */
  setProviderRegistry(providerRegistry: ProviderRegistry): void {
    this.providerRegistry = providerRegistry;
    this.modelCache.clear();
  }

  /**
   * Opt into the legacy fail-open behavior where an agent_id not found in a
   * configured registry returns the generic deny-all default config instead
   * of throwing {@link AgentNotFoundError}.
   *
   * Intended for tests / lightweight dev only. Production should leave this
   * `false` so a typo'd or deleted agent_id fails loudly.
   */
  setAllowDefaultFallback(allow: boolean): void {
    this.allowDefaultFallback = allow;
  }

  /**
   * Build a default agent config with deny-all permissions.
   *
   * Used as a fallback when the agent is not in the registry or the
   * registry is not configured. Deny-all (`read_keys: [], write_keys: []`)
   * ensures the agent cannot read or write any memory keys.
   *
   * @param agent_id - The ID to assign to the default config.
   * @returns A validated {@link AgentConfig} with sensible defaults.
   */
  getDefaultConfig(agent_id: string): AgentConfig {
    return {
      id: agent_id,
      name: agent_id,
      description: `Default agent config for ${agent_id}`,
      model: DEFAULT_AGENT_MODEL,
      provider: DEFAULT_AGENT_PROVIDER,
      system: DEFAULT_AGENT_SYSTEM_PROMPT,
      temperature: DEFAULT_AGENT_TEMPERATURE,
      maxSteps: DEFAULT_AGENT_MAX_STEPS,
      tools: [],
      read_keys: [],
      write_keys: [],
    };
  }

  /**
   * Load an agent config from the registry with caching and fallback.
   *
   * Resolution order:
   * 1. Return from cache if present and not expired.
   * 2. If no registry is configured, fall back to the default config
   *    (lightweight / "no persistence wired" mode).
   * 3. Query the registry. A configured-but-not-found agent FAILS CLOSED by
   *    default ({@link AgentNotFoundError}) — see {@link setAllowDefaultFallback}.
   *
   * Transient errors (DB connection, network) are **not** caught —
   * they propagate as {@link AgentLoadError} to prevent silent data loss.
   *
   * @param agent_id - The UUID of the agent to load.
   * @returns A validated {@link AgentConfig}.
   * @throws {AgentNotFoundError} When a configured registry has no such agent (fail closed).
   * @throws {AgentLoadError} On transient registry failures or missing API keys.
   */
  async loadAgent(agent_id: string): Promise<AgentConfig> {
    try {
      // Check cache with TTL (fallback entries have shorter TTL)
      const cached = this.configCache.get(agent_id);
      if (cached) {
        const ttl = cached.isFallback ? FALLBACK_CONFIG_CACHE_TTL_MS : AGENT_CONFIG_CACHE_TTL_MS;
        if ((Date.now() - cached.cachedAt) < ttl) {
          return cached.value;
        }
        this.configCache.delete(agent_id);
      }

      // No registry configured → lightweight mode: fall back to the default
      // config for any id. This is an explicit "persistence not wired" mode
      // (logged on every call), distinct from the fail-closed not-found case.
      if (!this.registry) {
        logger.warn('no_registry_fallback', { agent_id });
        return this.cacheAndReturn(agent_id, this.getDefaultConfig(agent_id), true);
      }

      // A non-UUID id can never be in the registry — treat as not found.
      if (!isValidUUID(agent_id)) {
        throw new AgentNotFoundError(agent_id);
      }

      // Load from registry
      const dbAgent = await this.registry.loadAgent(agent_id);

      if (!dbAgent) {
        throw new AgentNotFoundError(agent_id);
      }

      // Permissions are nullable — default to deny-all
      const permissions = dbAgent.permissions ?? { read_keys: [], write_keys: [] };

      const config: AgentConfig = {
        id: dbAgent.id,
        name: dbAgent.name,
        description: dbAgent.description || '',
        model: dbAgent.model,
        provider: dbAgent.provider || this.inferProvider(dbAgent.model),
        system: dbAgent.system_prompt,
        temperature: dbAgent.temperature,
        maxSteps: dbAgent.max_steps,
        tools: dbAgent.tools,
        ...(dbAgent.provider_options ? { providerOptions: { [dbAgent.provider]: dbAgent.provider_options } } : {}),
        ...(dbAgent.model_preference ? { model_preference: dbAgent.model_preference } : {}),
        read_keys: permissions.read_keys ?? [],
        write_keys: permissions.write_keys ?? [],
      };

      const validated = AgentConfigSchema.parse(config);
      logger.info('agent_loaded', { agent_id, model: validated.model, provider: validated.provider });
      return this.cacheAndReturn(agent_id, validated, false);
    } catch (error) {
      // AgentNotFoundError is a known, permanent error. By default we FAIL
      // CLOSED: a typo'd / deleted agent_id (or a non-UUID) must surface, not
      // silently run a generic deny-all assistant that "completes" with
      // garbage output and real token spend. Opt into the legacy fallback via
      // setAllowDefaultFallback(true) for tests / lightweight dev.
      if (error instanceof AgentNotFoundError) {
        if (this.allowDefaultFallback) {
          logger.warn('agent_not_found_fallback', { agent_id });
          return this.cacheAndReturn(agent_id, this.getDefaultConfig(agent_id), true);
        }
        logger.error('agent_not_found', error, { agent_id });
        throw error;
      }

      // Transient errors (DB connection, schema, network) — propagate up.
      // Do NOT silently fall back: running an agent with deny-all permissions
      // because of a momentary DB hiccup produces silent data loss.
      logger.error('agent_load_failed', error, { agent_id });
      throw new AgentLoadError(agent_id, error);
    }
  }

  /**
   * Get or create a cached {@link LanguageModel} for the given config.
   *
   * Models are cached by `provider:model` key, so two agents sharing the
   * same provider and model string share a single SDK instance.
   *
   * @param config - The agent config specifying provider and model.
   * @returns A ready-to-use {@link LanguageModel}.
   * @throws {AgentLoadError} If the required API key env var is not set.
   * @throws {UnsupportedProviderError} If the provider is unrecognised.
   */
  getModel(config: AgentConfig): LanguageModel {
    const cacheKey = `${config.provider}:${config.model}`;

    if (!this.modelCache.has(cacheKey)) {
      this.evictIfNeeded(this.modelCache);
      this.modelCache.set(cacheKey, this.createModel(config));
    }

    return this.modelCache.get(cacheKey)!;
  }

  /** Clear both the config and model caches (useful in tests). */
  clearCache(): void {
    this.modelCache.clear();
    this.configCache.clear();
  }

  // ── Private Helpers ──────────────────────────────────────────────────

  /**
   * Infer provider from model name using the provider registry's
   * registered prefixes. Falls back to {@link DEFAULT_AGENT_PROVIDER}
   * when no prefix matches.
   *
   * @param model - The model identifier string.
   * @returns The inferred provider name.
   */
  private inferProvider(model: string): string {
    const inferred = this.providerRegistry.inferProvider(model);
    if (inferred) return inferred;

    logger.warn('provider_inference_fallback', { model, defaulting_to: DEFAULT_AGENT_PROVIDER });
    return DEFAULT_AGENT_PROVIDER;
  }

  /**
   * Resolve a language model instance via the provider registry.
   *
   * @param config - The agent config specifying provider and model.
   * @returns A new {@link LanguageModel}.
   * @throws {UnsupportedProviderError} If the provider is not registered.
   * @throws {AgentLoadError} If model resolution fails (e.g. missing API key).
   */
  private createModel(config: AgentConfig): LanguageModel {
    try {
      return this.providerRegistry.resolveModel(config.provider, config.model);
    } catch (error) {
      if (error instanceof UnsupportedProviderError) throw error;
      throw new AgentLoadError(config.id, error);
    }
  }

  /**
   * Validate, cache, and return an agent config.
   *
   * @param agent_id - The agent ID (cache key).
   * @param config - The raw config to validate and cache.
   * @param isFallback - Whether this is a fallback config (shorter TTL).
   * @returns The validated {@link AgentConfig}.
   */
  private cacheAndReturn(agent_id: string, config: AgentConfig, isFallback: boolean): AgentConfig {
    const validated = AgentConfigSchema.parse(config);
    this.evictIfNeeded(this.configCache);
    this.configCache.set(agent_id, { value: validated, cachedAt: Date.now(), isFallback });
    return validated;
  }

  /**
   * Evict the oldest entry if the cache has reached capacity.
   *
   * Uses insertion-order eviction (Maps iterate in insertion order),
   * which approximates FIFO.
   *
   * @param cache - The cache map to potentially evict from.
   */
  private evictIfNeeded<T>(cache: Map<string, T>): void {
    if (cache.size >= MAX_AGENT_CONFIG_CACHE_SIZE) {
      const oldestCacheKey = cache.keys().next().value;
      if (oldestCacheKey !== undefined) {
        cache.delete(oldestCacheKey);
        logger.debug('cache_evicted', { key: oldestCacheKey, cache_size: cache.size });
      }
    }
  }
}
