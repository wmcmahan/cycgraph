/**
 * Budget-Aware Model Resolution
 *
 * Provides a unified system for runtime model selection based on
 * capability tiers and remaining budget. The {@link ModelResolver}
 * is a pure function configured on `GraphRunnerOptions` that maps
 * `(preference, provider, budget) → concrete model`.
 *
 * Security: The resolver MUST read budget from top-level
 * `WorkflowState` fields only — never from `memory`.
 * All resolver-internal memory keys use `_` prefix.
 *
 * Known limitations (Phase 1):
 * - The Workflow Architect does not yet generate graphs with model_preference.
 *   Agents must have model_preference set via the registry, not via architect-generated graphs.
 * - Evolution, annealing, and swarm node executors do not perform model resolution.
 *   Only standard agent and supervisor nodes support budget-aware model selection.
 *
 * @module agent/model-resolver
 */

import { z } from 'zod';
import { calculateCost } from '../utils/pricing.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('agent.model-resolver');

/**
 * Conservative fallback cost (USD) used when a model is not found in
 * MODEL_PRICING. This is intentionally high to ensure unknown models
 * are treated as expensive (fail-closed for budget enforcement).
 */
const UNKNOWN_MODEL_FALLBACK_COST_USD = 0.05;

// ─── Schemas ─────────────────────────────────────────────────────────

/**
 * Capability tier for model selection.
 *
 * Agents declare what they need, not which model to use:
 * - `high` — complex reasoning, planning, code generation
 * - `medium` — general-purpose tasks, summarization
 * - `low` — simple formatting, extraction, classification
 */
export const ModelTierSchema = z.enum(['high', 'medium', 'low']);
export type ModelTier = z.infer<typeof ModelTierSchema>;

/**
 * Reason the resolver chose a particular model.
 * Single source of truth for both resolution results and stream events.
 */
export const ModelResolutionReasonSchema = z.enum([
  'preferred',
  'budget_downgrade',
  'budget_critical',
]);
export type ModelResolutionReason = z.infer<typeof ModelResolutionReasonSchema>;

/**
 * Maps capability tiers to concrete model IDs per provider.
 *
 * @example
 * ```typescript
 * const tierMap: ModelTierMap = {
 *   high:   { anthropic: 'claude-opus-4-8',    openai: 'o3' },
 *   medium: { anthropic: 'claude-sonnet-4-6',  openai: 'gpt-4o' },
 *   low:    { anthropic: 'claude-haiku-4-5-20251001', openai: 'gpt-4o-mini' },
 * };
 * ```
 */
export type ModelTierMap = Partial<Record<ModelTier, Record<string, string>>>;

// ─── Result Types ────────────────────────────────────────────────────

/**
 * Discriminated union for model resolution outcomes.
 *
 * When `reason === 'preferred'`, the original tier was used.
 * When `reason === 'budget_downgrade'`, the resolver stepped down one tier.
 * When `reason === 'budget_critical'`, the resolver forced the lowest tier.
 */
export type ModelResolutionResult =
  | {
      reason: 'preferred';
      model: string;
      tier: ModelTier;
    }
  | {
      reason: 'budget_downgrade';
      model: string;
      original_tier: ModelTier;
      resolved_tier: ModelTier;
    }
  | {
      reason: 'budget_critical';
      model: string;
      original_tier: ModelTier;
      resolved_tier: 'low';
    };

// ─── Resolver Type ───────────────────────────────────────────────────

/**
 * Pure function that resolves a capability tier to a concrete model.
 *
 * Configured on `GraphRunnerOptions.modelResolver`. The engine calls
 * this before each agent execution when `model_preference` is set.
 *
 * @param preference - The agent's declared capability tier.
 * @param provider - The agent's LLM provider (e.g. `'anthropic'`).
 * @param remainingBudgetUsd - Remaining workflow budget, or `undefined` if unlimited.
 * @returns Resolution result, or `null` to fall back to `config.model`.
 */
export type ModelResolver = (
  preference: ModelTier,
  provider: string,
  remainingBudgetUsd: number | undefined,
) => ModelResolutionResult | null;

// ─── Cost Estimation ─────────────────────────────────────────────────

/**
 * Conservative token estimates per capability tier.
 * Used for pre-execution cost estimation when actual token counts
 * are unknown. Includes a ~15% headroom buffer.
 */
export const ESTIMATED_TOKENS_PER_CALL: Record<ModelTier, { input: number; output: number }> = {
  high:   { input: 4600, output: 2300 },
  medium: { input: 2300, output: 1150 },
  low:    { input: 1150, output: 575 },
};

/**
 * Estimate the cost of a single LLM call for a given model and tier.
 *
 * Accounts for provider-specific thinking/reasoning token budgets
 * when `providerOptions` are provided (e.g. Anthropic's `budgetTokens`).
 *
 * @param model - Concrete model ID (must exist in MODEL_PRICING for non-zero result).
 * @param tier - Capability tier for base token estimates.
 * @param providerOptions - Optional provider options from the agent config.
 * @returns Estimated cost in USD.
 */
export function estimateCallCost(
  model: string,
  tier: ModelTier,
  providerOptions?: Record<string, Record<string, unknown>>,
): number {
  const base = ESTIMATED_TOKENS_PER_CALL[tier];
  let extraInputTokens = 0;

  // Account for Anthropic thinking/reasoning budget tokens (billed as input)
  const anthropicOpts = providerOptions?.anthropic;
  if (anthropicOpts) {
    const thinking = anthropicOpts.thinking as Record<string, unknown> | undefined;
    if (thinking && typeof thinking.budgetTokens === 'number') {
      extraInputTokens += thinking.budgetTokens;
    }
  }

  const cost = calculateCost(model, base.input + extraInputTokens, base.output);
  if (cost === 0) {
    logger.warn('unknown_model_cost_fallback', {
      model,
      tier,
      fallbackCostUsd: UNKNOWN_MODEL_FALLBACK_COST_USD,
    });
    return UNKNOWN_MODEL_FALLBACK_COST_USD;
  }
  return cost;
}

// ─── Tier Ordering ───────────────────────────────────────────────────

const TIER_ORDER: readonly ModelTier[] = ['high', 'medium', 'low'] as const;

/**
 * Get the next lower tier, or `null` if already at lowest.
 */
function lowerTier(tier: ModelTier): ModelTier | null {
  const idx = TIER_ORDER.indexOf(tier);
  return idx < TIER_ORDER.length - 1 ? TIER_ORDER[idx + 1] : null;
}

// ─── Default Resolver Factory ────────────────────────────────────────

/**
 * Create a budget-aware model resolver from a tier map.
 *
 * Algorithm (simple heuristic v1):
 * 1. Look up preferred model from `tierMap[preference][provider]`
 * 2. If no budget constraint → return preferred
 * 3. Estimate this call's cost
 * 4. If estimated cost < 50% of remaining budget → return preferred (plenty of headroom)
 * 5. Otherwise step down one tier → return downgraded
 * 6. If already at lowest tier → return budget_critical
 *
 * @param tierMap - Mapping of tiers to concrete model IDs per provider.
 * @returns A {@link ModelResolver} function.
 */
export function defaultModelResolver(tierMap: ModelTierMap): ModelResolver {
  // Freeze the tier map to prevent runtime mutation (security)
  const frozen = Object.freeze(
    Object.fromEntries(
      Object.entries(tierMap).map(([tier, providers]) => [
        tier,
        Object.freeze({ ...providers }),
      ]),
    ),
  ) as ModelTierMap;

  return (preference, provider, remainingBudgetUsd) => {
    const preferred = frozen[preference]?.[provider];
    if (!preferred) return null;

    // No budget constraint → use preferred tier
    if (remainingBudgetUsd === undefined) {
      return { reason: 'preferred', model: preferred, tier: preference };
    }

    // Estimate this call's cost
    const estimatedCost = estimateCallCost(preferred, preference);

    // Plenty of headroom (cost < 50% of remaining budget)
    if (estimatedCost < remainingBudgetUsd * 0.5) {
      return { reason: 'preferred', model: preferred, tier: preference };
    }

    // Try one tier down
    const lower = lowerTier(preference);
    if (lower) {
      const downgraded = frozen[lower]?.[provider];
      if (downgraded) {
        return {
          reason: 'budget_downgrade',
          model: downgraded,
          original_tier: preference,
          resolved_tier: lower,
        };
      }
    }

    // Already at lowest tier or no lower tier available for this provider
    const lowestModel = frozen['low']?.[provider] ?? preferred;
    return { reason: 'budget_critical', model: lowestModel, original_tier: preference, resolved_tier: 'low' };
  };
}
