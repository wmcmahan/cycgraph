/**
 * Tests for the `callJudge` method on both providers.
 *
 * Stubs `globalThis.fetch` to avoid real network calls. Each test
 * restores the original fetch in afterEach so other tests are isolated.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createOllamaProvider } from '../../src/providers/ollama.js';
import { createOpenAIProvider } from '../../src/providers/openai.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetchOk(body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response);
}

function mockFetchError(status: number, statusText: string, body = '') {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    statusText,
    json: async () => ({}),
    text: async () => body,
  } as Response);
}

describe('createOllamaProvider — callJudge', () => {
  it('returns the response field from Ollama generate', async () => {
    globalThis.fetch = mockFetchOk({ response: '{"score": 0.9, "reasoning": "ok"}' }) as typeof fetch;
    const provider = createOllamaProvider();

    const result = await provider.callJudge('grade this');
    expect(result).toBe('{"score": 0.9, "reasoning": "ok"}');
  });

  it('uses the configured baseUrl', async () => {
    const fetchMock = mockFetchOk({ response: 'ok' });
    globalThis.fetch = fetchMock as typeof fetch;
    const provider = createOllamaProvider({ baseUrl: 'http://my-host:11434' });

    await provider.callJudge('x');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://my-host:11434/api/generate',
      expect.any(Object),
    );
  });

  it('throws with provider name + status on HTTP error', async () => {
    globalThis.fetch = mockFetchError(500, 'Internal Server Error') as typeof fetch;
    const provider = createOllamaProvider();

    await expect(provider.callJudge('x')).rejects.toThrow(/Ollama callJudge failed: HTTP 500/);
  });

  it('throws when response shape is wrong', async () => {
    globalThis.fetch = mockFetchOk({ unexpected: 'shape' }) as typeof fetch;
    const provider = createOllamaProvider();

    await expect(provider.callJudge('x')).rejects.toThrow(/unexpected response shape/);
  });

  it('throws with a timeout message when the request aborts', async () => {
    globalThis.fetch = vi.fn().mockImplementation((_url, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    }) as typeof fetch;
    const provider = createOllamaProvider();

    await expect(
      provider.callJudge('x', { timeoutMs: 10 }),
    ).rejects.toThrow(/timed out after 10ms/);
  });
});

describe('createOpenAIProvider — callJudge', () => {
  beforeEach(() => {
    process.env['OPENAI_API_KEY'] = 'test-key';
  });

  it('returns choices[0].message.content from chat completions', async () => {
    globalThis.fetch = mockFetchOk({
      choices: [{ message: { content: '{"score": 0.95, "reasoning": "good"}' } }],
    }) as typeof fetch;
    const provider = createOpenAIProvider({ apiKey: 'sk-test' });

    const result = await provider.callJudge('grade this');
    expect(result).toBe('{"score": 0.95, "reasoning": "good"}');
  });

  it('sends Authorization header with the API key', async () => {
    const fetchMock = mockFetchOk({
      choices: [{ message: { content: 'ok' } }],
    });
    globalThis.fetch = fetchMock as typeof fetch;
    const provider = createOpenAIProvider({ apiKey: 'sk-abc' });

    await provider.callJudge('x');
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-abc');
  });

  it('sends model + temperature + max_tokens in the request body', async () => {
    const fetchMock = mockFetchOk({
      choices: [{ message: { content: 'ok' } }],
    });
    globalThis.fetch = fetchMock as typeof fetch;
    const provider = createOpenAIProvider({ apiKey: 'sk', model: 'gpt-4o-mini' });

    await provider.callJudge('prompt text');
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.model).toBe('gpt-4o-mini');
    expect(body.temperature).toBe(0);
    expect(body.max_tokens).toBe(512);
    expect(body.messages).toEqual([{ role: 'user', content: 'prompt text' }]);
  });

  it('surfaces the response body in the error when HTTP fails', async () => {
    globalThis.fetch = mockFetchError(
      429,
      'Too Many Requests',
      '{"error":{"message":"rate_limit_exceeded"}}',
    ) as typeof fetch;
    const provider = createOpenAIProvider({ apiKey: 'sk' });

    await expect(provider.callJudge('x')).rejects.toThrow(
      /OpenAI callJudge failed: HTTP 429.*rate_limit_exceeded/,
    );
  });

  it('throws when response shape is wrong', async () => {
    globalThis.fetch = mockFetchOk({ unexpected: 'shape' }) as typeof fetch;
    const provider = createOpenAIProvider({ apiKey: 'sk' });

    await expect(provider.callJudge('x')).rejects.toThrow(/unexpected response shape/);
  });

  it('omits the detail suffix when the error body is empty', async () => {
    globalThis.fetch = mockFetchError(503, 'Service Unavailable', '') as typeof fetch;
    const provider = createOpenAIProvider({ apiKey: 'sk' });

    await expect(provider.callJudge('x')).rejects.toThrow(
      /OpenAI callJudge failed: HTTP 503 Service Unavailable$/,
    );
  });

  it('swallows a failure to read the error body and still reports the status', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      statusText: 'Bad Gateway',
      json: async () => ({}),
      text: async () => {
        throw new Error('body stream errored');
      },
    } as Response) as typeof fetch;
    const provider = createOpenAIProvider({ apiKey: 'sk' });

    await expect(provider.callJudge('x')).rejects.toThrow(
      /OpenAI callJudge failed: HTTP 502 Bad Gateway$/,
    );
  });

  it('throws with a timeout message when the request aborts', async () => {
    globalThis.fetch = vi.fn().mockImplementation((_url, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    }) as typeof fetch;
    const provider = createOpenAIProvider({ apiKey: 'sk' });

    await expect(
      provider.callJudge('x', { timeoutMs: 10 }),
    ).rejects.toThrow(/timed out after 10ms/);
  });
});
