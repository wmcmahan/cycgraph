/**
 * Agent Factory — Barrel Export
 *
 * Provides the singleton {@link agentFactory} instance and the
 * {@link configureAgentFactory} startup helper. All agent-factory
 * internals are accessed through this module.
 *
 * @module agent-factory
 */

import { AgentFactory } from './agent-factory.js';
import type { AgentRegistry } from '../../persistence/interfaces.js';
import type { ProviderRegistry } from '../provider-registry.js';

export { AgentNotFoundError, AgentLoadError } from './errors.js';

/** Singleton agent factory instance shared across the orchestrator. */
export const agentFactory = new AgentFactory();

/**
 * Configure the global agent factory with a registry backend.
 *
 * Call this once at startup to enable database-backed agent loading.
 * Without a registry, all agents use the default config with deny-all
 * permissions.
 *
 * @param registry - The persistence backend for agent configs.
 * @param options - Optional behavior flags.
 * @param options.allowDefaultFallback - When `true`, an agent_id not found in
 *   the registry returns the generic deny-all default instead of throwing
 *   `AgentNotFoundError`. Defaults to `false` (fail closed) so a typo'd or
 *   deleted agent_id surfaces as an error rather than silent garbage output.
 *   Intended for tests / lightweight dev only.
 */
export function configureAgentFactory(
  registry: AgentRegistry,
  options?: { allowDefaultFallback?: boolean },
): void {
  agentFactory.setRegistry(registry);
  if (options?.allowDefaultFallback !== undefined) {
    agentFactory.setAllowDefaultFallback(options.allowDefaultFallback);
  }
}

/**
 * Configure the global agent factory with a custom provider registry.
 *
 * Call this at startup to register additional LLM providers (Groq,
 * Ollama, etc.) beyond the built-in OpenAI and Anthropic.
 *
 * @param registry - The provider registry to use.
 */
export function configureProviderRegistry(registry: ProviderRegistry): void {
  agentFactory.setProviderRegistry(registry);
}

export { AgentFactory };
