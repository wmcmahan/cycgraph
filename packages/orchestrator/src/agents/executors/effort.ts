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
 * Per-provider spelling of the effort option. Every level is forwarded
 * verbatim, including `xhigh` and `max` on OpenAI, whose accepted set
 * varies by model generation — a level the target model does not accept
 * is deliberately left to the provider API to reject at call time rather
 * than clamped here, so the caller's intent is never silently degraded.
 */
const EFFORT_OPTION_BY_PROVIDER: Record<string, (level: EffortLevel) => Record<string, string>> = {
  anthropic: (level) => ({ effort: level }),
  openai: (level) => ({ reasoningEffort: level }),
};

/**
 * The `providerOptions` to pass to the LLM call: the config's own options
 * with the `effort` field translated into the provider's namespace.
 *
 * Exactly the providers `'anthropic'` and `'openai'` have a translation.
 * For any other provider id — including gateways that front those APIs,
 * such as `openrouter` or `bedrock` — the options are returned unchanged
 * (possibly `undefined`) and a debug log records the skipped effort, so
 * the no-op is observable rather than silent.
 */
export function effectiveProviderOptions(
  config: Pick<AgentConfig, 'provider' | 'effort' | 'providerOptions'>,
): AgentConfig['providerOptions'] {
  const { provider, effort, providerOptions } = config;
  if (effort === undefined) return providerOptions;

  const spell = EFFORT_OPTION_BY_PROVIDER[provider];
  if (spell === undefined) {
    logger.debug('effort_without_provider_mapping', { provider, effort });
    return providerOptions;
  }

  return {
    ...providerOptions,
    [provider]: { ...spell(effort), ...providerOptions?.[provider] },
  };
}
