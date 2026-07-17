/**
 * Anthropic provider tests.
 *
 * Stubs `globalThis.fetch` (the provider routes the SDK's fetch through it)
 * with real `Response` objects so the SDK's response handling runs
 * unmodified. No network calls.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createAnthropicProvider } from '../../src/providers/anthropic.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function messagesResponse(text: string): Response {
  return new Response(
    JSON.stringify({
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: 'claude-haiku-4-5-20251001',
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

describe('createAnthropicProvider', () => {
  it('throws without an API key', () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      expect(() => createAnthropicProvider()).toThrow(/ANTHROPIC_API_KEY/);
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    }
  });

  it('defaults to the pinned Haiku model (reproducibility)', () => {
    const provider = createAnthropicProvider({ apiKey: 'sk-test' });
    expect(provider.name).toBe('anthropic-claude-haiku-4-5-20251001');
  });

  it('returns joined text blocks from the Messages API', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(messagesResponse('Denver')) as typeof fetch;

    const provider = createAnthropicProvider({ apiKey: 'sk-test' });
    const result = await provider.callJudge('Where is Northgate headquartered?');
    expect(result).toBe('Denver');
  });

  it('sends the prompt to the Messages endpoint with the configured model', async () => {
    const fetchMock = vi.fn().mockResolvedValue(messagesResponse('ok'));
    globalThis.fetch = fetchMock as typeof fetch;

    const provider = createAnthropicProvider({ apiKey: 'sk-test', model: 'claude-opus-4-8' });
    await provider.callJudge('hello');

    const [url, init] = fetchMock.mock.calls[0] as [unknown, RequestInit];
    expect(String(url)).toContain('/v1/messages');
    const body = JSON.parse(String(init.body)) as { model: string; messages: unknown[] };
    expect(body.model).toBe('claude-opus-4-8');
    expect(body.messages).toEqual([{ role: 'user', content: 'hello' }]);
  });

  it('wraps API errors with the provider name and status', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'bad model' } }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      ),
    ) as typeof fetch;

    const provider = createAnthropicProvider({ apiKey: 'sk-test' });
    await expect(provider.callJudge('x')).rejects.toThrow(/Anthropic callJudge failed: HTTP 400/);
  });

  it('throws when the response has no text blocks', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'msg_test', type: 'message', role: 'assistant',
          model: 'claude-haiku-4-5-20251001',
          content: [], stop_reason: 'refusal',
          usage: { input_tokens: 10, output_tokens: 0 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    ) as typeof fetch;

    const provider = createAnthropicProvider({ apiKey: 'sk-test' });
    await expect(provider.callJudge('x')).rejects.toThrow(/no text blocks.*refusal/);
  });

  it('estimates cost with a warning above the threshold', () => {
    const provider = createAnthropicProvider({ apiKey: 'sk-test', costWarningThreshold: 0.01 });
    const estimate = provider.estimateCost(100);
    expect(estimate.estimatedUsd).toBeGreaterThan(0);
    expect(estimate.warning).toContain('exceeds warning threshold');
  });
});
