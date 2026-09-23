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
  'gpt-6-astra': { inputPerMToken: 10.00, outputPerMToken: 50.00 },
  'gpt-6-sol': { inputPerMToken: 2.00, outputPerMToken: 10.00 },
  'gpt-6-luna': { inputPerMToken: 0.10, outputPerMToken: 0.50 },
  'gpt-5.1': { inputPerMToken: 1.25, outputPerMToken: 10.00 },
  'gpt-5': { inputPerMToken: 1.25, outputPerMToken: 10.00 },
  'gpt-5-mini': { inputPerMToken: 0.25, outputPerMToken: 2.00 },
  'gpt-5-nano': { inputPerMToken: 0.05, outputPerMToken: 0.40 },
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
  'claude-fable-5-1': { inputPerMToken: 10.00, outputPerMToken: 50.00 },
  'claude-opus-5-5': { inputPerMToken: 4.00, outputPerMToken: 20.00 },
  'claude-fable-5': { inputPerMToken: 10.00, outputPerMToken: 50.00 },
  'claude-opus-5': { inputPerMToken: 5.00, outputPerMToken: 25.00 },
  'claude-sonnet-5': { inputPerMToken: 2.00, outputPerMToken: 10.00 },
  'claude-opus-4-8': { inputPerMToken: 5.00, outputPerMToken: 25.00 },
  'claude-opus-4-7': { inputPerMToken: 5.00, outputPerMToken: 25.00 },
  'claude-opus-4-6': { inputPerMToken: 5.00, outputPerMToken: 25.00 },
  'claude-opus-4-20250514': { inputPerMToken: 15.00, outputPerMToken: 75.00 },
  'claude-sonnet-4-20250514': { inputPerMToken: 3.00, outputPerMToken: 15.00 },
  'claude-sonnet-4-6': { inputPerMToken: 3.00, outputPerMToken: 15.00 },
  'claude-haiku-4-5': { inputPerMToken: 1.00, outputPerMToken: 5.00 },
  'claude-haiku-4-5-20251001': { inputPerMToken: 1.00, outputPerMToken: 5.00 },
  'claude-3-5-sonnet-20241022': { inputPerMToken: 3.00, outputPerMToken: 15.00 },
  'claude-3-5-haiku-20241022': { inputPerMToken: 0.80, outputPerMToken: 4.00 },
  'claude-3-opus-20240229': { inputPerMToken: 15.00, outputPerMToken: 75.00 },
  // Google Gemini (3.1 Pro: base tier, prompts under 200K tokens;
  // 3.6–3.8 Flash rates are promotional through 2026-12-31, doubling after)
  'gemini-3.8-flash': { inputPerMToken: 0.75, outputPerMToken: 3.75 },
  'gemini-3.7-flash': { inputPerMToken: 0.75, outputPerMToken: 3.75 },
  'gemini-3.6-flash': { inputPerMToken: 0.75, outputPerMToken: 3.75 },
  'gemini-3.5-flash': { inputPerMToken: 1.50, outputPerMToken: 9.00 },
  'gemini-3.5-flash-lite': { inputPerMToken: 0.30, outputPerMToken: 2.50 },
  'gemini-3.1-pro-preview': { inputPerMToken: 2.00, outputPerMToken: 12.00 },
  'gemini-2.5-flash-lite': { inputPerMToken: 0.10, outputPerMToken: 0.40 },
  // xAI Grok (base tier: prompts under 200K tokens; longer prompts bill higher)
  'grok-4.7': { inputPerMToken: 2.00, outputPerMToken: 6.00 },
  'grok-4.6': { inputPerMToken: 2.00, outputPerMToken: 6.00 },
  'grok-4.5': { inputPerMToken: 2.00, outputPerMToken: 6.00 },
  'grok-4.3': { inputPerMToken: 1.25, outputPerMToken: 2.50 },
  'grok-build-0.1': { inputPerMToken: 1.00, outputPerMToken: 2.00 },
  // DeepSeek API (peak rates; off-peak windows bill half)
  'deepseek-v4-pro': { inputPerMToken: 1.32, outputPerMToken: 3.96 },
  'deepseek-flash': { inputPerMToken: 0.30, outputPerMToken: 1.20 },
  // Mistral API (`-latest` aliases; cached input bills at 10% via CACHE_READ_INPUT_RATE)
  'mistral-large-latest': { inputPerMToken: 0.50, outputPerMToken: 1.50 },
  'mistral-medium-latest': { inputPerMToken: 1.50, outputPerMToken: 7.50 },
  'mistral-small-latest': { inputPerMToken: 0.15, outputPerMToken: 0.60 },
  'codestral-latest': { inputPerMToken: 0.30, outputPerMToken: 0.90 },
  'ministral-8b-latest': { inputPerMToken: 0.15, outputPerMToken: 0.15 },
  'ministral-3b-latest': { inputPerMToken: 0.10, outputPerMToken: 0.10 },
  // Groq-hosted open models. The Llama rates are the last published ones:
  // both moved to enterprise contact-sales pricing on 2026-08-26, so hosts
  // with negotiated rates should override via setModelPricing/loadPricingTable.
  'llama-3.3-70b-versatile': { inputPerMToken: 0.59, outputPerMToken: 0.79 },
  'llama-3.1-8b-instant': { inputPerMToken: 0.05, outputPerMToken: 0.08 },
  'openai/gpt-oss-120b': { inputPerMToken: 0.15, outputPerMToken: 0.60 },
  'openai/gpt-oss-20b': { inputPerMToken: 0.075, outputPerMToken: 0.30 },
  // Cerebras (qwen-3.8-27b has no public rate — dedicated-endpoint pricing only)
  'gpt-oss-120b': { inputPerMToken: 0.35, outputPerMToken: 0.75 },
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

/** Prompt-cache read tokens bill at this fraction of the input rate. */
export const CACHE_READ_INPUT_RATE = 0.1;

/** Prompt-cache write tokens bill at this multiple of the input rate. */
export const CACHE_WRITE_INPUT_RATE = 1.25;

/** Prompt-cache token counts for cache-aware cost calculation. */
export interface CacheTokens {
  /** Input tokens served from the prompt cache (billed at ~10%). */
  readTokens?: number;
  /** Input tokens written to the prompt cache (billed at ~125%). */
  writeTokens?: number;
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
 * When `cache` is provided, input is priced at cache-aware rates: reads at
 * {@link CACHE_READ_INPUT_RATE} and writes at {@link CACHE_WRITE_INPUT_RATE}
 * of the input rate, with the remainder at full price. Providers report
 * cached tokens inside `inputTokens` at full count, so pricing the raw
 * number flat overstates a well-cached agentic run several-fold — and a
 * `max_cost_usd` budget fed that number trips long before real spend
 * reaches it.
 *
 * @param model - Model identifier resolved via {@link getModelPricing} (runtime overrides, then {@link MODEL_PRICING}).
 * @param inputTokens - Number of input (prompt) tokens, cache traffic included.
 * @param outputTokens - Number of output (completion) tokens.
 * @param cache - Optional prompt-cache read/write token counts within `inputTokens`.
 * @returns Estimated cost in USD (always finite and >= 0).
 */
export function calculateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cache?: CacheTokens,
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

  const cacheRead = Math.min(sanitizeTokens(cache?.readTokens ?? 0), input);
  const cacheWrite = Math.min(sanitizeTokens(cache?.writeTokens ?? 0), input - cacheRead);
  const noCache = input - cacheRead - cacheWrite;
  const inputEquivalent = noCache
    + cacheRead * CACHE_READ_INPUT_RATE
    + cacheWrite * CACHE_WRITE_INPUT_RATE;

  return (
    (inputEquivalent * pricing.inputPerMToken) / 1_000_000 +
    (output * pricing.outputPerMToken) / 1_000_000
  );
}
