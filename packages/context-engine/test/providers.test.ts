/**
 * Unit tests for the default provider implementations (providers/defaults):
 * resolveTokenRatio, DefaultTokenCounter, and the Noop providers.
 */

import { describe, it, expect } from 'vitest';
import {
  DefaultTokenCounter,
  NoopCompressionProvider,
  NoopEmbeddingProvider,
  NoopSummarizationProvider,
  resolveTokenRatio,
} from '../src/providers/defaults.js';

const DEFAULT_RATIO = 4.0;

describe('resolveTokenRatio', () => {
  it('returns the model-family ratio for known prefixes', () => {
    expect(resolveTokenRatio('gpt-4o-2024-05-13')).toBe(3.5);
    expect(resolveTokenRatio('claude-sonnet-4-6')).toBe(3.8);
    expect(resolveTokenRatio('llama-3.1-70b')).toBe(3.6);
    expect(resolveTokenRatio('deepseek-v3')).toBe(3.6);
    expect(resolveTokenRatio('gemini-2.0-flash')).toBe(3.7);
    expect(resolveTokenRatio('mistral-large')).toBe(3.6);
  });

  it('matches prefixes case-insensitively', () => {
    expect(resolveTokenRatio('GPT-4o')).toBe(3.5);
    expect(resolveTokenRatio('Claude-Sonnet-4')).toBe(3.8);
  });

  it('returns the default ratio for unknown models', () => {
    expect(resolveTokenRatio('some-unknown-model')).toBe(DEFAULT_RATIO);
  });

  it('returns the default ratio when the model is undefined', () => {
    expect(resolveTokenRatio(undefined)).toBe(DEFAULT_RATIO);
  });
});

describe('DefaultTokenCounter', () => {
  const counter = new DefaultTokenCounter();

  it('counts tokens using the model-family ratio', () => {
    const text = 'Hello, world!';

    expect(counter.countTokens(text, 'claude-sonnet-4-6')).toBe(Math.ceil(text.length / 3.8));
    expect(counter.countTokens(text, 'gpt-4o')).toBe(Math.ceil(text.length / 3.5));
  });

  it('uses the default ratio when no model is specified', () => {
    const text = 'a'.repeat(100);

    expect(counter.countTokens(text)).toBe(Math.ceil(100 / DEFAULT_RATIO));
  });

  it('returns 0 for an empty string', () => {
    expect(counter.countTokens('')).toBe(0);
  });

  it('scales proportionally with text length', () => {
    const text = 'a'.repeat(10000);

    expect(counter.countTokens(text, 'claude-sonnet-4-6')).toBe(Math.ceil(10000 / 3.8));
  });
});

describe('NoopCompressionProvider', () => {
  it('returns a uniform 0.5 score per token', async () => {
    const scores = await new NoopCompressionProvider().scoreTokenImportance(['a', 'b', 'c']);

    expect(scores).toEqual([0.5, 0.5, 0.5]);
  });

  it('returns an empty array for empty input', async () => {
    const scores = await new NoopCompressionProvider().scoreTokenImportance([]);

    expect(scores).toEqual([]);
  });
});

describe('NoopEmbeddingProvider', () => {
  it('reports zero dimensions', () => {
    expect(new NoopEmbeddingProvider().dimensions).toBe(0);
  });

  it('rejects with a not-configured error when embedding', async () => {
    await expect(new NoopEmbeddingProvider().embed(['test'])).rejects.toThrow('EmbeddingProvider not configured');
  });
});

describe('NoopSummarizationProvider', () => {
  it('rejects with a not-configured error when summarizing', async () => {
    await expect(new NoopSummarizationProvider().summarize('test', 100)).rejects.toThrow('SummarizationProvider not configured');
  });
});
