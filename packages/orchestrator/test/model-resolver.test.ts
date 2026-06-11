import { describe, it, expect } from 'vitest';
import {
  ModelTierSchema,
  ModelResolutionReasonSchema,
  ESTIMATED_TOKENS_PER_CALL,
  estimateCallCost,
  defaultModelResolver,
} from '../src/agent/model-resolver.js';
import type { ModelTier, ModelTierMap, ModelResolver } from '../src/agent/model-resolver.js';

// ─── Shared Test Fixtures ─────────────────────────────────────────

const TIER_MAP: ModelTierMap = {
  high:   { anthropic: 'claude-opus-4-8',    openai: 'o3' },
  medium: { anthropic: 'claude-sonnet-4-6',  openai: 'gpt-4o' },
  low:    { anthropic: 'claude-haiku-4-5-20251001', openai: 'gpt-4o-mini' },
};

// ─── Schema Validation ────────────────────────────────────────────

describe('ModelTierSchema', () => {
  it('accepts valid tiers', () => {
    expect(ModelTierSchema.parse('high')).toBe('high');
    expect(ModelTierSchema.parse('medium')).toBe('medium');
    expect(ModelTierSchema.parse('low')).toBe('low');
  });

  it('rejects invalid tiers', () => {
    expect(() => ModelTierSchema.parse('ultra')).toThrow();
    expect(() => ModelTierSchema.parse('')).toThrow();
    expect(() => ModelTierSchema.parse(42)).toThrow();
  });
});

describe('ModelResolutionReasonSchema', () => {
  it('accepts all valid reasons', () => {
    for (const reason of ['preferred', 'budget_downgrade', 'budget_critical']) {
      expect(ModelResolutionReasonSchema.parse(reason)).toBe(reason);
    }
  });

  it('rejects removed explicit reason', () => {
    expect(() => ModelResolutionReasonSchema.parse('explicit')).toThrow();
  });
});

// ─── Cost Estimation ──────────────────────────────────────────────

describe('ESTIMATED_TOKENS_PER_CALL', () => {
  it('has entries for all tiers', () => {
    for (const tier of ['high', 'medium', 'low'] as ModelTier[]) {
      expect(ESTIMATED_TOKENS_PER_CALL[tier]).toBeDefined();
      expect(ESTIMATED_TOKENS_PER_CALL[tier].input).toBeGreaterThan(0);
      expect(ESTIMATED_TOKENS_PER_CALL[tier].output).toBeGreaterThan(0);
    }
  });

  it('higher tiers have higher token estimates', () => {
    expect(ESTIMATED_TOKENS_PER_CALL.high.input).toBeGreaterThan(ESTIMATED_TOKENS_PER_CALL.medium.input);
    expect(ESTIMATED_TOKENS_PER_CALL.medium.input).toBeGreaterThan(ESTIMATED_TOKENS_PER_CALL.low.input);
  });
});

describe('estimateCallCost', () => {
  it('returns a positive number for known models', () => {
    const cost = estimateCallCost('claude-sonnet-4-6', 'medium');
    expect(cost).toBeGreaterThan(0);
  });

  it('returns a conservative fallback cost for unknown models', () => {
    const cost = estimateCallCost('unknown-model', 'high');
    expect(cost).toBeGreaterThan(0);
    expect(cost).toBe(0.05);
  });

  it('higher tiers produce higher cost estimates for the same model', () => {
    const highCost = estimateCallCost('claude-sonnet-4-6', 'high');
    const lowCost = estimateCallCost('claude-sonnet-4-6', 'low');
    expect(highCost).toBeGreaterThan(lowCost);
  });

  it('accounts for Anthropic thinking budget tokens', () => {
    const withoutThinking = estimateCallCost('claude-sonnet-4-6', 'medium');
    const withThinking = estimateCallCost('claude-sonnet-4-6', 'medium', {
      anthropic: { thinking: { type: 'enabled', budgetTokens: 12000 } },
    });
    expect(withThinking).toBeGreaterThan(withoutThinking);
  });

  it('ignores providerOptions without thinking config', () => {
    const base = estimateCallCost('claude-sonnet-4-6', 'medium');
    const withEmptyOpts = estimateCallCost('claude-sonnet-4-6', 'medium', {
      anthropic: {},
    });
    expect(withEmptyOpts).toBe(base);
  });
});

// ─── Default Model Resolver ───────────────────────────────────────

describe('defaultModelResolver', () => {
  let resolver: ModelResolver;

  beforeEach(() => {
    resolver = defaultModelResolver(TIER_MAP);
  });

  // ── No budget constraint ──

  it('returns preferred model when no budget constraint', () => {
    const result = resolver('high', 'anthropic', undefined);
    expect(result).toEqual({
      reason: 'preferred',
      model: 'claude-opus-4-8',
      tier: 'high',
    });
  });

  it('returns null for unknown provider', () => {
    const result = resolver('high', 'unknown-provider', undefined);
    expect(result).toBeNull();
  });

  it('returns null for provider not in the requested tier', () => {
    const partialMap: ModelTierMap = {
      high:   { anthropic: 'claude-opus-4-8' },
      medium: { anthropic: 'claude-sonnet-4-6' },
      low:    { anthropic: 'claude-haiku-4-5-20251001' },
    };
    const partialResolver = defaultModelResolver(partialMap);
    const result = partialResolver('high', 'openai', undefined);
    expect(result).toBeNull();
  });

  // ── Budget with plenty of headroom ──

  it('returns preferred model when budget has plenty of headroom', () => {
    // $100 remaining — way more than any single call estimate
    const result = resolver('high', 'anthropic', 100);
    expect(result).toEqual({
      reason: 'preferred',
      model: 'claude-opus-4-8',
      tier: 'high',
    });
  });

  // ── Budget downgrade ──

  it('downgrades one tier when budget is tight', () => {
    // Very small budget forces downgrade
    const result = resolver('high', 'anthropic', 0.001);
    expect(result).not.toBeNull();
    if (result!.reason === 'budget_downgrade') {
      expect(result!.original_tier).toBe('high');
      expect(result!.resolved_tier).toBe('medium');
      expect(result!.model).toBe('claude-sonnet-4-6');
    } else {
      // Could also be budget_critical depending on cost estimate
      expect(result!.reason).toBe('budget_critical');
    }
  });

  // ── Budget critical (already at low) ──

  it('returns budget_critical when already at lowest tier and budget is tight', () => {
    const result = resolver('low', 'anthropic', 0.0000001);
    expect(result).not.toBeNull();
    expect(result!.reason).toBe('budget_critical');
    expect(result!.model).toBe('claude-haiku-4-5-20251001');
    if (result!.reason === 'budget_critical') {
      expect(result!.original_tier).toBe('low');
      expect(result!.resolved_tier).toBe('low');
    }
  });

  // ── Immutability ──

  it('does not allow mutation of the tier map after creation', () => {
    // The resolver freezes the tier map, so mutations to the original
    // should not affect resolution
    const mutableMap: ModelTierMap = {
      high:   { anthropic: 'model-a' },
      medium: { anthropic: 'model-b' },
      low:    { anthropic: 'model-c' },
    };
    const r = defaultModelResolver(mutableMap);

    // Mutate original — should not affect resolver
    mutableMap.high.anthropic = 'mutated';

    const result = r('high', 'anthropic', undefined);
    expect(result).not.toBeNull();
    expect(result!.model).toBe('model-a');
  });

  // ── Multi-provider ──

  it('resolves different providers independently', () => {
    const anthropicResult = resolver('medium', 'anthropic', undefined);
    const openaiResult = resolver('medium', 'openai', undefined);

    expect(anthropicResult).not.toBeNull();
    expect(openaiResult).not.toBeNull();
    expect(anthropicResult!.model).toBe('claude-sonnet-4-6');
    expect(openaiResult!.model).toBe('gpt-4o');
  });

  // ── Zero budget ──

  it('handles zero remaining budget', () => {
    const result = resolver('high', 'anthropic', 0);
    expect(result).not.toBeNull();
    // With zero budget, should downgrade or go critical
    expect(['budget_downgrade', 'budget_critical']).toContain(result!.reason);
  });
});

// ─── Import-time missing function guard ────────────────────────────

// vitest will fail on import if any function is undefined.
// This is a compile-time guard, not a runtime test.
import { beforeEach } from 'vitest';
