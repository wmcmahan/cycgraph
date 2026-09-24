/**
 * Provider-neutral effort translation.
 *
 * An agent config's `effort` declares how hard the model should think
 * without naming a provider; this module folds it into the
 * `providerOptions` handed to the AI SDK call, using each provider's own
 * option key. Providers with no effort control are left untouched, and an
 * explicit value for the same key inside `providerOptions` wins, so raw
 * provider options remain the escape hatch.
 *
 * @module agents/executors/effort
 */

import type { AgentConfig, EffortLevel } from '../types.js';

/** Per-provider spelling of the effort option. */
const EFFORT_OPTION_BY_PROVIDER: Record<string, (level: EffortLevel) => Record<string, string>> = {
  anthropic: (level) => ({ effort: level }),
  openai: (level) => ({ reasoningEffort: level }),
};

/**
 * The `providerOptions` to pass to the LLM call: the config's own options
 * with the `effort` field translated into the provider's namespace.
 * Returns the options unchanged (possibly `undefined`) when no effort is
 * set or the provider has no effort control.
 */
export function effectiveProviderOptions(
  config: Pick<AgentConfig, 'provider' | 'effort' | 'providerOptions'>,
): AgentConfig['providerOptions'] {
  const { provider, effort, providerOptions } = config;
  if (effort === undefined) return providerOptions;

  const spell = EFFORT_OPTION_BY_PROVIDER[provider];
  if (spell === undefined) return providerOptions;

  return {
    ...providerOptions,
    [provider]: { ...spell(effort), ...providerOptions?.[provider] },
  };
}
