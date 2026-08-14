/**
 * Model selection shared by the examples.
 *
 * Examples run against a hosted Anthropic model by default. Set
 * `CYCGRAPH_MODEL` to an Ollama tag to run the same graph locally against
 * `ollama serve`, with no API key and no cost:
 *
 *   CYCGRAPH_MODEL=qwen2.5:7b npx tsx examples/supervisor-routing/supervisor-routing.ts
 *
 * That is how the examples are smoke-tested: the graph, the helpers, and the
 * engine path are identical, only the model behind them changes.
 *
 * @module examples/_model
 */

import { createProviderRegistry, registerOllamaProvider } from '@cycgraph/orchestrator';
import type { ProviderRegistry } from '@cycgraph/orchestrator';
import { createOpenAI } from '@ai-sdk/openai';

/** The model every example resolves through. */
export const MODEL = process.env['CYCGRAPH_MODEL'] ?? 'claude-sonnet-4-6';

/** Whether the run is against a local Ollama model rather than a hosted one. */
export const IS_LOCAL = !/^claude/i.test(MODEL);

/** Provider matching {@link MODEL}. Ollama tags carry no inferable prefix. */
export const PROVIDER = IS_LOCAL ? 'ollama' : 'anthropic';

/**
 * A run-scoped provider registry, with Ollama wired when {@link MODEL} is a
 * local tag. Returns `undefined` for hosted models so the example uses the
 * engine's built-in providers.
 *
 * Ollama speaks the OpenAI-compatible API, so an `@ai-sdk/openai` client
 * pointed at the local server is the whole adapter.
 */
export function exampleProviders(): ProviderRegistry | undefined {
  if (!IS_LOCAL) return undefined;

  const providers = createProviderRegistry();
  registerOllamaProvider(providers, ({ baseURL }) => {
    const provider = createOpenAI({ baseURL: `${baseURL}/v1`, apiKey: 'ollama' });
    return (modelId) => provider.chat(modelId);
  });
  return providers;
}

/**
 * Whether the environment can run an example. Hosted models need a key; local
 * ones need nothing beyond a reachable `ollama serve`.
 */
export function missingCredentials(): string | null {
  if (IS_LOCAL) return null;
  return process.env['ANTHROPIC_API_KEY']
    ? null
    : 'ANTHROPIC_API_KEY is not set. Either export it, or set CYCGRAPH_MODEL to an Ollama tag (e.g. qwen2.5:7b) to run locally.';
}
