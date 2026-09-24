/**
 * Tests for provider-neutral effort translation.
 */

import { describe, it, expect } from 'vitest';
import { effectiveProviderOptions } from '../src/agents/executors/effort.js';

describe('effectiveProviderOptions', () => {
  it('translates effort to the anthropic option key', () => {
    const result = effectiveProviderOptions({ provider: 'anthropic', effort: 'low' });

    expect(result).toEqual({ anthropic: { effort: 'low' } });
  });

  it('translates effort to the openai option key', () => {
    const result = effectiveProviderOptions({ provider: 'openai', effort: 'xhigh' });

    expect(result).toEqual({ openai: { reasoningEffort: 'xhigh' } });
  });

  it('returns providerOptions unchanged when no effort is set', () => {
    const providerOptions = { anthropic: { thinking: { type: 'adaptive' } } };

    expect(effectiveProviderOptions({ provider: 'anthropic', providerOptions })).toBe(providerOptions);
  });

  it('returns undefined when neither effort nor providerOptions are set', () => {
    expect(effectiveProviderOptions({ provider: 'anthropic' })).toBeUndefined();
  });

  it('ignores effort for a provider with no effort control', () => {
    const providerOptions = { ollama: { numCtx: 8192 } };

    expect(effectiveProviderOptions({ provider: 'ollama', effort: 'high', providerOptions }))
      .toBe(providerOptions);
  });

  it('merges effort into existing options for the same provider', () => {
    const result = effectiveProviderOptions({
      provider: 'anthropic',
      effort: 'medium',
      providerOptions: { anthropic: { thinking: { type: 'adaptive' } } },
    });

    expect(result).toEqual({ anthropic: { effort: 'medium', thinking: { type: 'adaptive' } } });
  });

  it('lets an explicit providerOptions value win over the effort field', () => {
    const result = effectiveProviderOptions({
      provider: 'openai',
      effort: 'low',
      providerOptions: { openai: { reasoningEffort: 'max' } },
    });

    expect(result).toEqual({ openai: { reasoningEffort: 'max' } });
  });

  it('preserves options namespaced under other providers', () => {
    const result = effectiveProviderOptions({
      provider: 'anthropic',
      effort: 'high',
      providerOptions: { openai: { reasoningEffort: 'low' } },
    });

    expect(result).toEqual({
      anthropic: { effort: 'high' },
      openai: { reasoningEffort: 'low' },
    });
  });
});
