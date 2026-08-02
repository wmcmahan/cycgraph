import { describe, it, expect, vi, beforeEach } from 'vitest';

// Track warned models across tests by resetting module state
let calculateCost: typeof import('../src/utils/pricing.js').calculateCost;
let MODEL_PRICING: typeof import('../src/utils/pricing.js').MODEL_PRICING;
let setModelPricing: typeof import('../src/utils/pricing.js').setModelPricing;
let loadPricingTable: typeof import('../src/utils/pricing.js').loadPricingTable;
let getModelPricing: typeof import('../src/utils/pricing.js').getModelPricing;
let clearPricingOverrides: typeof import('../src/utils/pricing.js').clearPricingOverrides;

// Mock logger to capture warnings
const warnFn = vi.fn();
vi.mock('../src/utils/logger.js', () => ({
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
  const mod = await import('../src/utils/pricing.js');
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
    expect(MODEL_PRICING['gpt-4o']).toEqual({ inputPerMToken: 2.5, outputPerMToken: 10 });
  });

  it('clearPricingOverrides removes all runtime overrides', () => {
    setModelPricing('gpt-4o', { inputPerMToken: 1, outputPerMToken: 2 });

    clearPricingOverrides();

    expect(getModelPricing('gpt-4o')).toEqual({ inputPerMToken: 2.5, outputPerMToken: 10 });
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
