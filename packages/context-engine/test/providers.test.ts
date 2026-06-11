import { describe, it, expect } from 'vitest';
import {
  DefaultTokenCounter,
  NoopCompressionProvider,
  NoopEmbeddingProvider,
  NoopSummarizationProvider,
  resolveTokenRatio,
} from '../src/providers/defaults.js';

describe('resolveTokenRatio', () => {
  it('returns model-specific ratio for known prefixes', () => {
    expect(resolveTokenRatio('gpt-4o-2024-05-13')).toBe(3.5);
    expect(resolveTokenRatio('claude-sonnet-4-6')).toBe(3.8);
    expect(resolveTokenRatio('llama-3.1-70b')).toBe(3.6);
    expect(resolveTokenRatio('deepseek-v3')).toBe(3.6);
    expect(resolveTokenRatio('gemini-2.0-flash')).toBe(3.7);
    expect(resolveTokenRatio('mistral-large')).toBe(3.6);
  });

  it('is case-insensitive', () => {
    expect(resolveTokenRatio('GPT-4o')).toBe(3.5);
    expect(resolveTokenRatio('Claude-Sonnet-4')).toBe(3.8);
  });

  it('returns default ratio for unknown models', () => {
    expect(resolveTokenRatio('some-unknown-model')).toBe(4.0);
  });

  it('returns default ratio when model is undefined', () => {
    expect(resolveTokenRatio(undefined)).toBe(4.0);
  });
});

describe('DefaultTokenCounter', () => {
  const counter = new DefaultTokenCounter();

  it('counts tokens using model-family ratio', () => {
    const text = 'Hello, world!'; // 13 chars
    // Claude ratio: 3.8 → ceil(13/3.8) = 4
    expect(counter.countTokens(text, 'claude-sonnet-4-6')).toBe(4);
    // GPT-4o ratio: 3.5 → ceil(13/3.5) = 4
    expect(counter.countTokens(text, 'gpt-4o')).toBe(4);
  });

  it('uses default ratio when no model specified', () => {
    const text = 'a'.repeat(100); // 100 chars
    // Default ratio: 4.0 → ceil(100/4) = 25
    expect(counter.countTokens(text)).toBe(25);
  });

  it('returns 0 for empty string', () => {
    expect(counter.countTokens('')).toBe(0);
  });

  it('handles long text proportionally', () => {
    const text = 'a'.repeat(10000);
    const tokens = counter.countTokens(text, 'claude-sonnet-4-6');
    // 10000 / 3.8 ≈ 2632
    expect(tokens).toBe(Math.ceil(10000 / 3.8));
  });
});

describe('NoopCompressionProvider', () => {
  it('returns uniform scores', async () => {
    const provider = new NoopCompressionProvider();
    const scores = await provider.scoreTokenImportance(['a', 'b', 'c']);
    expect(scores).toEqual([0.5, 0.5, 0.5]);
  });

  it('returns empty array for empty input', async () => {
    const provider = new NoopCompressionProvider();
    const scores = await provider.scoreTokenImportance([]);
    expect(scores).toEqual([]);
  });
});

describe('NoopEmbeddingProvider', () => {
  it('throws descriptive error when called', async () => {
    const provider = new NoopEmbeddingProvider();
    await expect(provider.embed(['test'])).rejects.toThrow('EmbeddingProvider not configured');
  });

  it('has zero dimensions', () => {
    const provider = new NoopEmbeddingProvider();
    expect(provider.dimensions).toBe(0);
  });
});

describe('NoopSummarizationProvider', () => {
  it('throws descriptive error when called', async () => {
    const provider = new NoopSummarizationProvider();
    await expect(provider.summarize('test', 100)).rejects.toThrow('SummarizationProvider not configured');
  });
});
