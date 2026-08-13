/**
 * Agent Factory — Barrel Export
 *
 * Provides the singleton {@link agentFactory} instance and the
 * {@link configureAgentFactory} startup helper. All agent-factory
 * internals are accessed through this module.
 *
 * @module agents/factory/index
 */

import { AgentFactory } from './agent-factory.js';
import type { AgentRegistry } from '../../persistence/interfaces.js';
import type { ProviderRegistry } from '../providers/provider-registry.js';

export { AgentNotFoundError, AgentLoadError } from './errors.js';

/** Singleton agent factory instance shared across the orchestrator. */
export const agentFactory = new AgentFactory();

/**
 * Configure the PROCESS-GLOBAL agent factory with a registry backend.
 *
 * @deprecated Prefer scoping the registry into the run via
 *   `GraphRunnerOptions.registry` (and `providers`). The global factory is
 *   shared across every run in the process, so two concurrent runs with
 *   different registries contaminate each other — the multi-tenant footgun
 *   `GraphRunnerOptions.registry` removes. This helper remains for
 *   single-process, single-tenant setups and will be removed once consumers
 *   (including mc-ai-api) have migrated.
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
 * Configure the PROCESS-GLOBAL agent factory with a custom provider registry.
 *
 * @deprecated Prefer scoping providers into the run via
 *   `GraphRunnerOptions.providers`. Like {@link configureAgentFactory}, this
 *   mutates process-global state shared across concurrent runs. Kept for
 *   single-tenant setups until consumers migrate.
 *
 * @param registry - The provider registry to use.
 */
export function configureProviderRegistry(registry: ProviderRegistry): void {
  agentFactory.setProviderRegistry(registry);
}

export { AgentFactory };
