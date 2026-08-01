/**
 * Tests for model capability profiles: the MODEL_PROFILES matrix and
 * resolveModelProfile prefix matching.
 */

import { describe, it, expect } from 'vitest';
import { resolveModelProfile, MODEL_PROFILES } from '../src/routing/model-profiles.js';

describe('resolveModelProfile', () => {
  it('resolves a gpt-4o model string to the gpt-4o profile', () => {
    const profile = resolveModelProfile('gpt-4o-2024-05-13');

    expect(profile?.family).toBe('gpt-4o');
    expect(profile?.supportsTabular).toBe(true);
    expect(profile?.supportsCaching).toBe(true);
  });

  it('resolves a claude model string to the claude profile', () => {
    const profile = resolveModelProfile('claude-sonnet-4-6');

    expect(profile?.family).toBe('claude');
    expect(profile?.maxContextTokens).toBe(200_000);
  });

  it('resolves gemma as a JSON-preferring, non-tabular profile', () => {
    const profile = resolveModelProfile('gemma-2-9b');

    expect(profile?.prefersJson).toBe(true);
    expect(profile?.supportsTabular).toBe(false);
  });

  it('resolves phi as a JSON-preferring profile', () => {
    expect(resolveModelProfile('phi-3-mini')?.prefersJson).toBe(true);
  });

  it('matches family prefixes case-insensitively', () => {
    expect(resolveModelProfile('GPT-4o')?.family).toBe('gpt-4o');
    expect(resolveModelProfile('Claude-Sonnet')?.family).toBe('claude');
  });

  it('returns undefined for an unknown model', () => {
    expect(resolveModelProfile('totally-unknown-model')).toBeUndefined();
  });

  it('returns undefined when no model is given', () => {
    expect(resolveModelProfile(undefined)).toBeUndefined();
  });
});

describe('MODEL_PROFILES', () => {
  it('includes every supported model family', () => {
    expect(Object.keys(MODEL_PROFILES)).toEqual([
      'gpt-4o',
      'gpt-4',
      'o1',
      'o3',
      'claude',
      'llama',
      'deepseek',
      'qwen',
      'gemini',
      'mistral',
      'gemma',
      'phi',
    ]);
  });
});
