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
 * @module cost/pricing
 */

import { createLogger } from '../observability/logger.js';

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
  'gpt-4-turbo': { inputPerMToken: 10.00, outputPerMToken: 30.00 },
  'gpt-4': { inputPerMToken: 30.00, outputPerMToken: 60.00 },
  'o1': { inputPerMToken: 15.00, outputPerMToken: 60.00 },
  'o1-preview': { inputPerMToken: 15.00, outputPerMToken: 60.00 },
  'o1-mini': { inputPerMToken: 1.10, outputPerMToken: 4.40 },
  'o3': { inputPerMToken: 2.00, outputPerMToken: 8.00 },
  'o3-mini': { inputPerMToken: 1.10, outputPerMToken: 4.40 },
  'o4-mini': { inputPerMToken: 1.10, outputPerMToken: 4.40 },
  // Anthropic Claude
  'claude-opus-4-8': { inputPerMToken: 5.00, outputPerMToken: 25.00 },
  'claude-opus-4-20250514': { inputPerMToken: 15.00, outputPerMToken: 75.00 },
  'claude-sonnet-4-20250514': { inputPerMToken: 3.00, outputPerMToken: 15.00 },
  'claude-sonnet-4-6': { inputPerMToken: 3.00, outputPerMToken: 15.00 },
  'claude-haiku-4-5-20251001': { inputPerMToken: 1.00, outputPerMToken: 5.00 },
  'claude-3-5-sonnet-20241022': { inputPerMToken: 3.00, outputPerMToken: 15.00 },
  'claude-3-5-haiku-20241022': { inputPerMToken: 0.80, outputPerMToken: 4.00 },
  'claude-3-opus-20240229': { inputPerMToken: 15.00, outputPerMToken: 75.00 },
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

/**
 * Runtime pricing overrides, consulted before {@link MODEL_PRICING}.
 *
 * The static table is the reviewed, offline default; hosts that want an
 * external source of truth (e.g. LiteLLM's community pricing JSON, an
 * internal rate card) load it at startup via {@link loadPricingTable} —
 * the trust decision stays with the host, and the engine never fetches
 * pricing over the network itself.
 */
const pricingOverrides = new Map<string, ModelPricing>();

/**
 * Validate one pricing entry. Budget enforcement is a security control, so a
 * poisoned or malformed entry (NaN, negative, Infinity) must be impossible to
 * register — a NaN price would make `total_cost_usd` NaN and permanently
 * disable the USD budget check.
 */
function assertValidPricing(model: string, pricing: ModelPricing): void {
  const { inputPerMToken, outputPerMToken } = pricing;
  if (
    !Number.isFinite(inputPerMToken) || inputPerMToken < 0 ||
    !Number.isFinite(outputPerMToken) || outputPerMToken < 0
  ) {
    throw new Error(
      `Invalid pricing for model "${model}": inputPerMToken=${inputPerMToken}, ` +
      `outputPerMToken=${outputPerMToken} (both must be finite and >= 0)`,
    );
  }
}

/**
 * Register or update pricing for a single model at runtime.
 * Overrides take precedence over the static {@link MODEL_PRICING} table.
 *
 * @throws {Error} If the pricing values are not finite non-negative numbers.
 */
export function setModelPricing(model: string, pricing: ModelPricing): void {
  assertValidPricing(model, pricing);
  pricingOverrides.set(model, { ...pricing });
  warnedModels.delete(model);
}

/**
 * Bulk-register pricing for many models at once (e.g. a table synced from
 * an external source at host startup). Validates every entry before applying
 * any — a partially-poisoned table is rejected atomically.
 *
 * @throws {Error} If any entry is invalid; no entries are applied.
 */
export function loadPricingTable(table: Record<string, ModelPricing>): void {
  for (const [model, pricing] of Object.entries(table)) {
    assertValidPricing(model, pricing);
  }
  for (const [model, pricing] of Object.entries(table)) {
    pricingOverrides.set(model, { ...pricing });
    warnedModels.delete(model);
  }
}

/**
 * Resolve effective pricing for a model: runtime overrides first, then the
 * static table. Returns `undefined` for unknown models.
 */
export function getModelPricing(model: string): ModelPricing | undefined {
  return pricingOverrides.get(model) ?? MODEL_PRICING[model];
}

/** Remove all runtime pricing overrides (test helper). */
export function clearPricingOverrides(): void {
  pricingOverrides.clear();
}

/** Models already warned about (prevents repeated log noise). */
const warnedModels = new Set<string>();
/** Cap on {@link warnedModels} so a stream of varied unknown model ids can't grow it unbounded. */
const MAX_WARNED_MODELS = 1000;

/** Coerce a token count to a finite, non-negative number (malformed usage → 0). */
function sanitizeTokens(n: number): number {
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Calculate cost in USD for a given model and token counts.
 *
 * Returns `0` for unknown models (graceful degradation) and logs
 * a warning once per unknown model. Token counts are coerced to finite,
 * non-negative values first: a `NaN` from malformed provider usage would
 * otherwise produce a `NaN` cost, and since every `NaN > budget` comparison is
 * `false`, that single bad value would permanently stop the USD budget from
 * ever enforcing again.
 *
 * @param model - Model identifier resolved via {@link getModelPricing} (runtime overrides, then {@link MODEL_PRICING}).
 * @param inputTokens - Number of input (prompt) tokens.
 * @param outputTokens - Number of output (completion) tokens.
 * @returns Estimated cost in USD (always finite and >= 0).
 */
export function calculateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const input = sanitizeTokens(inputTokens);
  const output = sanitizeTokens(outputTokens);

  const pricing = getModelPricing(model);
  if (!pricing) {
    if (!warnedModels.has(model)) {
      if (warnedModels.size >= MAX_WARNED_MODELS) warnedModels.clear();
      warnedModels.add(model);
      logger.warn('unknown_model_pricing', { model });
    }
    return 0;
  }
  return (
    (input * pricing.inputPerMToken) / 1_000_000 +
    (output * pricing.outputPerMToken) / 1_000_000
  );
}
