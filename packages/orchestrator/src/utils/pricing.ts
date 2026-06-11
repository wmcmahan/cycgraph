/**
 * Model Pricing Table
 *
 * Per-model cost lookup used by the cost tracking reducer and the
 * budget enforcement logic. Prices are in **USD per 1 million tokens**.
 *
 * Returns `0` for unlisted models — cost tracking continues even
 * when pricing data is unavailable, and a warning is logged once
 * per unknown model.
 *
 * @module utils/pricing
 */

import { createLogger } from './logger.js';

const logger = createLogger('utils.pricing');

/**
 * Per-model pricing in USD per 1 million tokens.
 */
export interface ModelPricing {
  /** Cost per 1 M input (prompt) tokens. */
  inputPerMToken: number;
  /** Cost per 1 M output (completion) tokens. */
  outputPerMToken: number;
}

/**
 * Known model pricing table.
 *
 * Add new entries here when onboarding additional models.
 * Prices are sourced from provider pricing pages.
 */
export const MODEL_PRICING: Readonly<Record<string, ModelPricing>> = {
  // OpenAI
  'gpt-4o': { inputPerMToken: 2.50, outputPerMToken: 10.00 },
  'gpt-4o-mini': { inputPerMToken: 0.15, outputPerMToken: 0.60 },
  'o1': { inputPerMToken: 15.00, outputPerMToken: 60.00 },
  'o1-mini': { inputPerMToken: 1.10, outputPerMToken: 4.40 },
  'o3-mini': { inputPerMToken: 1.10, outputPerMToken: 4.40 },
  // Anthropic Claude
  'claude-opus-4-8': { inputPerMToken: 5.00, outputPerMToken: 25.00 },
  'claude-opus-4-20250514': { inputPerMToken: 15.00, outputPerMToken: 75.00 },
  'claude-sonnet-4-20250514': { inputPerMToken: 3.00, outputPerMToken: 15.00 },
  'claude-sonnet-4-6': { inputPerMToken: 3.00, outputPerMToken: 15.00 },
  'claude-haiku-4-5-20251001': { inputPerMToken: 1.00, outputPerMToken: 5.00 },
  'claude-3-5-sonnet-20241022': { inputPerMToken: 3.00, outputPerMToken: 15.00 },
  'claude-3-5-haiku-20241022': { inputPerMToken: 0.80, outputPerMToken: 4.00 },
  // Ollama / local models (no API cost)
  'llama3.1': { inputPerMToken: 0, outputPerMToken: 0 },
  'llama3.1:8b': { inputPerMToken: 0, outputPerMToken: 0 },
  'llama3.1:70b': { inputPerMToken: 0, outputPerMToken: 0 },
  'llama3.2': { inputPerMToken: 0, outputPerMToken: 0 },
  'llama3.2:3b': { inputPerMToken: 0, outputPerMToken: 0 },
  'llama3.3': { inputPerMToken: 0, outputPerMToken: 0 },
  'llama3.3:70b': { inputPerMToken: 0, outputPerMToken: 0 },
  'qwen2.5': { inputPerMToken: 0, outputPerMToken: 0 },
  'qwen2.5:7b': { inputPerMToken: 0, outputPerMToken: 0 },
  'mistral': { inputPerMToken: 0, outputPerMToken: 0 },
  'mistral:7b': { inputPerMToken: 0, outputPerMToken: 0 },
  'gemma2': { inputPerMToken: 0, outputPerMToken: 0 },
  'gemma2:9b': { inputPerMToken: 0, outputPerMToken: 0 },
  'gemma3': { inputPerMToken: 0, outputPerMToken: 0 },
  'phi3': { inputPerMToken: 0, outputPerMToken: 0 },
  'deepseek-r1': { inputPerMToken: 0, outputPerMToken: 0 },
  'deepseek-r1:8b': { inputPerMToken: 0, outputPerMToken: 0 },
};

/** Models already warned about (prevents repeated log noise). */
const warnedModels = new Set<string>();

/**
 * Calculate cost in USD for a given model and token counts.
 *
 * Returns `0` for unknown models (graceful degradation) and logs
 * a warning once per unknown model.
 *
 * @param model - Model identifier (must match a key in {@link MODEL_PRICING}).
 * @param inputTokens - Number of input (prompt) tokens.
 * @param outputTokens - Number of output (completion) tokens.
 * @returns Estimated cost in USD.
 */
export function calculateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const pricing = MODEL_PRICING[model];
  if (!pricing) {
    if (!warnedModels.has(model)) {
      warnedModels.add(model);
      logger.warn('unknown_model_pricing', { model });
    }
    return 0;
  }
  return (
    (inputTokens * pricing.inputPerMToken) / 1_000_000 +
    (outputTokens * pricing.outputPerMToken) / 1_000_000
  );
}
