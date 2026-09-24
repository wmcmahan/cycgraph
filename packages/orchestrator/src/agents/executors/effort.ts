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
import { createLogger } from '../../observability/logger.js';

const logger = createLogger('agent.effort');

/**
 * Per-provider spelling of the effort option, keyed by the exact provider
 * id an agent config carries: `'anthropic'` and `'openai'` only. Every
 * other id — `'azure'`, `'bedrock'`, `'vertex'`, `'openrouter'`, `'groq'`,
 * `'ollama'`, any custom registration — has no entry and leaves `effort`
 * untranslated.
 *
 * The level is forwarded verbatim, so a level the provider's own option
 * does not accept (OpenAI's `reasoningEffort` has historically taken
 * `minimal | low | medium | high`, not `xhigh` / `max`) reaches the API
 * and is rejected there. That is deliberate: this map translates the
 * option's spelling, not its value range, so a level a provider adds
 * later works without a release here.
 */
const EFFORT_OPTION_BY_PROVIDER: Record<string, (level: EffortLevel) => Record<string, string>> = {
  anthropic: (level) => ({ effort: level }),
  openai: (level) => ({ reasoningEffort: level }),
};

/**
 * The `providerOptions` to pass to the LLM call: the config's own options
 * with the `effort` field translated into the provider's namespace.
 * Returns the options unchanged (possibly `undefined`) when no effort is
 * set or the provider has no effort control.
 *
 * Only `'anthropic'` (option `effort`) and `'openai'` (option
 * `reasoningEffort`) have a translation; for any other provider id a set
 * `effort` is a no-op and is logged at debug.
 */
export function effectiveProviderOptions(
  config: Pick<AgentConfig, 'provider' | 'effort' | 'providerOptions'>,
): AgentConfig['providerOptions'] {
  const { provider, effort, providerOptions } = config;
  if (effort === undefined) return providerOptions;

  const spell = EFFORT_OPTION_BY_PROVIDER[provider];
  if (spell === undefined) {
    logger.debug('effort_unsupported_provider', { provider, effort });
    return providerOptions;
  }

  return {
    ...providerOptions,
    [provider]: { ...spell(effort), ...providerOptions?.[provider] },
  };
}
