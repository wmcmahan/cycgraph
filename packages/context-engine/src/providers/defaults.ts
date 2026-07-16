/**
 * Default Provider Implementations
 *
 * Ships with the engine for zero-dependency operation. The token counter
 * uses a model-family lookup table for reasonable accuracy (~5-10% error).
 * Other providers are no-ops or throw descriptive errors when the
 * capability isn't available.
 *
 * @module providers/defaults
 */

import type { TokenCounter, CompressionProvider, EmbeddingProvider, SummarizationProvider } from './types.js';

/**
 * Per-model-family character-to-token ratios.
 *
 * These are empirical averages across mixed content (prose, code, JSON).
 * Error margin: ~5-10% vs exact tokenizer. Sufficient for budget
 * allocation; use tiktoken adapter for exact counting.
 */
const MODEL_FAMILY_RATIOS: Record<string, number> = {
  // OpenAI cl100k_base / o200k_base family
  'gpt-4': 3.5,
  'gpt-4o': 3.5,
  'gpt-4-turbo': 3.5,
  'gpt-3.5': 3.5,
  'o1': 3.5,
  'o3': 3.5,
  // Anthropic
  'claude': 3.8,
  // Meta Llama
  'llama': 3.6,
  // DeepSeek
  'deepseek': 3.6,
  // Qwen
  'qwen': 3.6,
  // Google Gemini
  'gemini': 3.7,
  // Mistral
  'mistral': 3.6,
};

const DEFAULT_CHARS_PER_TOKEN = 4.0;

/**
 * Resolve the character-to-token ratio for a model string.
 *
 * Matches against known model family prefixes. Falls back to a
 * conservative 4.0 chars/token estimate if no match is found.
 */
export function resolveTokenRatio(model?: string): number {
  if (!model) return DEFAULT_CHARS_PER_TOKEN;

  const lower = model.toLowerCase();
  for (const [prefix, ratio] of Object.entries(MODEL_FAMILY_RATIOS)) {
    if (lower.startsWith(prefix)) return ratio;
  }
  return DEFAULT_CHARS_PER_TOKEN;
}

/**
 * Token counter using model-family character ratios.
 *
 * Provides ~5-10% accuracy on mixed content without any external
 * dependencies. For exact counting, inject a tiktoken-based counter.
 */
export class DefaultTokenCounter implements TokenCounter {
  countTokens(text: string, model?: string): number {
    const ratio = resolveTokenRatio(model);
    return Math.ceil(text.length / ratio);
  }
}

/**
 * Compression provider that returns uniform importance scores.
 * NOT a no-op under budget pressure: with uniform scores no token outranks
 * another, so segments already within budget pass through unchanged, but
 * over-budget segments degrade to simple truncation (the pruner's stable
 * sort keeps earlier tokens on ties).
 */
export class NoopCompressionProvider implements CompressionProvider {
  async scoreTokenImportance(tokens: string[]): Promise<number[]> {
    return tokens.map(() => 0.5);
  }
}

/**
 * Embedding provider that throws when called.
 * Semantic features (semantic dedup, similarity search) require a real provider.
 */
export class NoopEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions = 0;

  async embed(_texts: string[]): Promise<number[][]> {
    throw new Error(
      'EmbeddingProvider not configured. Semantic features (semantic dedup, similarity search) ' +
      'require an embedding provider. Pass one via pipeline config or use @cycgraph/context-engine ' +
      'with a provider adapter (e.g., OpenAI, transformers.js).',
    );
  }
}

/**
 * Summarization provider that throws when called.
 * Summarization features require a real LLM provider.
 */
export class NoopSummarizationProvider implements SummarizationProvider {
  async summarize(_text: string, _maxTokens: number): Promise<string> {
    throw new Error(
      'SummarizationProvider not configured. Summarization features require an LLM provider. ' +
      'Pass one via pipeline config.',
    );
  }
}
