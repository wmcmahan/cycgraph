import { describe, it, expect, vi, beforeEach } from 'vitest';

// Track warned models across tests by resetting module state
let calculateCost: typeof import('../src/cost/pricing.js').calculateCost;
let MODEL_PRICING: typeof import('../src/cost/pricing.js').MODEL_PRICING;
let setModelPricing: typeof import('../src/cost/pricing.js').setModelPricing;
let loadPricingTable: typeof import('../src/cost/pricing.js').loadPricingTable;
let getModelPricing: typeof import('../src/cost/pricing.js').getModelPricing;
let clearPricingOverrides: typeof import('../src/cost/pricing.js').clearPricingOverrides;

// Mock logger to capture warnings
const warnFn = vi.fn();
vi.mock('../src/observability/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: warnFn,
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

beforeEach(async () => {
  warnFn.mockClear();
  vi.resetModules();
  const mod = await import('../src/cost/pricing.js');
  calculateCost = mod.calculateCost;
  MODEL_PRICING = mod.MODEL_PRICING;
  setModelPricing = mod.setModelPricing;
  loadPricingTable = mod.loadPricingTable;
  getModelPricing = mod.getModelPricing;
  clearPricingOverrides = mod.clearPricingOverrides;
});

describe('calculateCost', () => {
  it('returns correct cost for known OpenAI model', () => {
    const cost = calculateCost('gpt-4o', 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(12.50);
  });

  it('returns correct cost for known Anthropic model', () => {
    const cost = calculateCost('claude-sonnet-4-20250514', 500_000, 100_000);
    expect(cost).toBeCloseTo(1.5 + 1.5);
  });

  it('returns 0 for zero tokens', () => {
    expect(calculateCost('gpt-4o', 0, 0)).toBe(0);
  });

  it('prices cache reads at a tenth and writes at a quarter premium of the input rate', () => {
    const flat = calculateCost('claude-opus-5', 1_000_000, 0);

    const cached = calculateCost('claude-opus-5', 1_000_000, 0, {
      readTokens: 800_000,
      writeTokens: 100_000,
    });

    expect(flat).toBeCloseTo(5.0);
    expect(cached).toBeCloseTo((100_000 + 80_000 + 125_000) * 5 / 1_000_000);
  });

  describe('cached-input rates', () => {
    const ONE_MILLION = 1_000_000;

    it('prices cache reads at the model\'s published cached-input rate', () => {
      expect(calculateCost('claude-opus-5-5', ONE_MILLION, 0, { readTokens: ONE_MILLION })).toBeCloseTo(0.20, 10);
    });

    it('prices cache reads above a tenth where the provider charges more', () => {
      expect(calculateCost('gpt-4o', ONE_MILLION, 0, { readTokens: ONE_MILLION })).toBeCloseTo(1.25, 10);
    });

    it('falls back to a tenth of the input rate for a model without a cached rate', () => {
      expect(calculateCost('claude-sonnet-5-5', ONE_MILLION, 0, { readTokens: ONE_MILLION })).toBeCloseTo(0.20, 10);
      expect(calculateCost('claude-opus-5', ONE_MILLION, 0, { readTokens: ONE_MILLION })).toBeCloseTo(0.50, 10);
    });

    it('keeps cache writes at a quarter premium of the input rate', () => {
      expect(calculateCost('claude-fable-5-1', ONE_MILLION, 0, { writeTokens: ONE_MILLION })).toBeCloseTo(12.50, 10);
    });

    it('sets a cached rate no higher than the input rate', () => {
      const overpriced = Object.entries(MODEL_PRICING)
        .filter(([, pricing]) => pricing.cachedInputPerMToken !== undefined && pricing.cachedInputPerMToken > pricing.inputPerMToken)
        .map(([model]) => model);

      expect(overpriced).toEqual([]);
    });
  });

  it('prices flat when no cache detail is given', () => {
    expect(calculateCost('claude-opus-5', 1_000_000, 0, {})).toBeCloseTo(5.0);
  });

  it('clamps cache counts that exceed the input total', () => {
    const cost = calculateCost('claude-opus-5', 100_000, 0, { readTokens: 500_000 });

    expect(cost).toBeCloseTo(100_000 * 0.1 * 5 / 1_000_000);
  });

  it('never returns NaN for malformed (NaN) token counts', () => {
    const cost = calculateCost('gpt-4o', NaN, 100);
    expect(Number.isFinite(cost)).toBe(true);
    expect(cost).toBeGreaterThanOrEqual(0);
    expect(cost).toBe(calculateCost('gpt-4o', 0, 100));
  });

  it('treats negative token counts as zero', () => {
    expect(calculateCost('gpt-4o', -1000, -1000)).toBe(0);
  });

  it('returns 0 for unknown model and logs a warning', () => {
    const cost = calculateCost('unknown-model-xyz', 1000, 1000);
    expect(cost).toBe(0);
    expect(warnFn).toHaveBeenCalledWith('unknown_model_pricing', { model: 'unknown-model-xyz' });
  });

  it('only warns once per unknown model', () => {
    calculateCost('never-heard-of', 100, 100);
    calculateCost('never-heard-of', 200, 200);
    expect(warnFn).toHaveBeenCalledTimes(1);
  });

  it('warns separately for different unknown models', () => {
    calculateCost('model-a', 100, 100);
    calculateCost('model-b', 100, 100);
    expect(warnFn).toHaveBeenCalledTimes(2);
  });

  it('handles very small token counts correctly', () => {
    const cost = calculateCost('gpt-4o-mini', 1, 1);
    const expected = (1 * 0.15) / 1_000_000 + (1 * 0.60) / 1_000_000;
    expect(cost).toBeCloseTo(expected);
  });
});

describe('MODEL_PRICING', () => {
  it('contains expected OpenAI models', () => {
    expect(MODEL_PRICING['gpt-4o']).toBeDefined();
    expect(MODEL_PRICING['gpt-4o-mini']).toBeDefined();
  });

  it('contains expected Anthropic models', () => {
    expect(MODEL_PRICING['claude-sonnet-4-20250514']).toBeDefined();
    expect(MODEL_PRICING['claude-opus-4-20250514']).toBeDefined();
  });

  it('has non-negative pricing for all models', () => {
    for (const [, pricing] of Object.entries(MODEL_PRICING)) {
      expect(pricing.inputPerMToken).toBeGreaterThanOrEqual(0);
      expect(pricing.outputPerMToken).toBeGreaterThanOrEqual(0);
    }
  });

  it('has positive pricing for cloud provider models', () => {
    expect(MODEL_PRICING['gpt-4o']!.inputPerMToken).toBeGreaterThan(0);
    expect(MODEL_PRICING['claude-sonnet-4-20250514']!.inputPerMToken).toBeGreaterThan(0);
  });

  it('has zero pricing for local Ollama models', () => {
    expect(MODEL_PRICING['llama3.1:8b']!.inputPerMToken).toBe(0);
    expect(MODEL_PRICING['llama3.1:8b']!.outputPerMToken).toBe(0);
    expect(MODEL_PRICING['qwen2.5:7b']!.inputPerMToken).toBe(0);
    expect(MODEL_PRICING['qwen2.5:7b']!.outputPerMToken).toBe(0);
  });
});

describe('runtime pricing overrides', () => {
  it('setModelPricing registers pricing for an unknown model', () => {
    setModelPricing('my-custom-model', { inputPerMToken: 4, outputPerMToken: 16 });
    expect(calculateCost('my-custom-model', 1_000_000, 1_000_000)).toBeCloseTo(20);
    expect(warnFn).not.toHaveBeenCalled();
  });

  it('overrides take precedence over the static table', () => {
    setModelPricing('gpt-4o', { inputPerMToken: 1, outputPerMToken: 2 });
    expect(calculateCost('gpt-4o', 1_000_000, 1_000_000)).toBeCloseTo(3);
    expect(getModelPricing('gpt-4o')).toEqual({ inputPerMToken: 1, outputPerMToken: 2 });
    expect(MODEL_PRICING['gpt-4o']).toEqual({ inputPerMToken: 2.5, outputPerMToken: 10, cachedInputPerMToken: 1.25 });
  });

  it('clearPricingOverrides removes all runtime overrides', () => {
    setModelPricing('gpt-4o', { inputPerMToken: 1, outputPerMToken: 2 });

    clearPricingOverrides();

    expect(getModelPricing('gpt-4o')).toEqual({ inputPerMToken: 2.5, outputPerMToken: 10, cachedInputPerMToken: 1.25 });
    expect(getModelPricing('my-custom-model')).toBeUndefined();
  });

  it('loadPricingTable bulk-registers entries', () => {
    loadPricingTable({
      'model-a': { inputPerMToken: 1, outputPerMToken: 1 },
      'model-b': { inputPerMToken: 2, outputPerMToken: 2 },
    });
    expect(calculateCost('model-a', 1_000_000, 0)).toBeCloseTo(1);
    expect(calculateCost('model-b', 0, 1_000_000)).toBeCloseTo(2);
  });

  it('rejects non-finite or negative pricing', () => {
    expect(() => setModelPricing('bad', { inputPerMToken: NaN, outputPerMToken: 1 })).toThrow(/finite/);
    expect(() => setModelPricing('bad', { inputPerMToken: 1, outputPerMToken: -5 })).toThrow(/finite/);
    expect(() => setModelPricing('bad', { inputPerMToken: Infinity, outputPerMToken: 1 })).toThrow(/finite/);
  });

  it('rejects a non-finite or negative cached-input price', () => {
    expect(() => setModelPricing('bad', { inputPerMToken: 1, outputPerMToken: 1, cachedInputPerMToken: NaN }))
      .toThrow('cachedInputPerMToken=NaN (must be finite and >= 0)');
    expect(() => setModelPricing('bad', { inputPerMToken: 1, outputPerMToken: 1, cachedInputPerMToken: -0.1 }))
      .toThrow('cachedInputPerMToken=-0.1 (must be finite and >= 0)');
  });

  it('prices cache reads at an override\'s cached-input rate', () => {
    setModelPricing('my-cached-model', { inputPerMToken: 4, outputPerMToken: 0, cachedInputPerMToken: 0.5 });

    expect(calculateCost('my-cached-model', 1_000_000, 0, { readTokens: 1_000_000 })).toBeCloseTo(0.5, 10);
  });

  it('loadPricingTable rejects atomically — a bad entry applies nothing', () => {
    expect(() =>
      loadPricingTable({
        'good-model': { inputPerMToken: 1, outputPerMToken: 1 },
        'bad-model': { inputPerMToken: NaN, outputPerMToken: 1 },
      }),
    ).toThrow(/finite/);
    expect(getModelPricing('good-model')).toBeUndefined();
  });

  it('clears the warned-model set once it reaches the cap', () => {
    for (let i = 0; i < 1000; i++) calculateCost(`unknown-model-${i}`, 1, 1);
    calculateCost('cap-trigger-model', 1, 1);
    warnFn.mockClear();

    calculateCost('unknown-model-5', 1, 1);

    expect(warnFn).toHaveBeenCalledTimes(1);
  });

  it('registering pricing clears the unknown-model warning state', () => {
    calculateCost('late-priced-model', 100, 100);
    expect(warnFn).toHaveBeenCalledTimes(1);
    setModelPricing('late-priced-model', { inputPerMToken: 1, outputPerMToken: 1 });
    calculateCost('late-priced-model', 100, 100);
    expect(warnFn).toHaveBeenCalledTimes(1);
  });
});
