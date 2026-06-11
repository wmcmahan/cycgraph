import { describe, it, expect } from 'vitest';
import { resolveModelProfile, MODEL_PROFILES } from '../src/routing/model-profiles.js';

describe('resolveModelProfile', () => {
  it('resolves GPT-4o profile', () => {
    const profile = resolveModelProfile('gpt-4o-2024-05-13');
    expect(profile?.family).toBe('gpt-4o');
    expect(profile?.supportsTabular).toBe(true);
    expect(profile?.supportsCaching).toBe(true);
  });

  it('resolves Claude profile', () => {
    const profile = resolveModelProfile('claude-sonnet-4-6');
    expect(profile?.family).toBe('claude');
    expect(profile?.maxContextTokens).toBe(200_000);
  });

  it('resolves Gemma as JSON-preferring', () => {
    const profile = resolveModelProfile('gemma-2-9b');
    expect(profile?.prefersJson).toBe(true);
    expect(profile?.supportsTabular).toBe(false);
  });

  it('resolves Phi as JSON-preferring', () => {
    const profile = resolveModelProfile('phi-3-mini');
    expect(profile?.prefersJson).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(resolveModelProfile('GPT-4o')).toBeDefined();
    expect(resolveModelProfile('Claude-Sonnet')).toBeDefined();
  });

  it('returns undefined for unknown model', () => {
    expect(resolveModelProfile('totally-unknown-model')).toBeUndefined();
  });

  it('returns undefined for undefined input', () => {
    expect(resolveModelProfile(undefined)).toBeUndefined();
  });

  it('has profiles for all major families', () => {
    const families = Object.keys(MODEL_PROFILES);
    expect(families).toContain('gpt-4o');
    expect(families).toContain('claude');
    expect(families).toContain('llama');
    expect(families).toContain('deepseek');
    expect(families).toContain('gemini');
    expect(families).toContain('mistral');
    expect(families).toContain('gemma');
    expect(families).toContain('phi');
  });
});
