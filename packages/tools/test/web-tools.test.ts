/**
 * Tests for the web tool factories (src/web/web-fetch.ts,
 * src/web/http-request.ts): request shaping, allowlists, response capping,
 * and taint declarations. All network access is stubbed.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { ToolDefinitionError } from '@cycgraph/orchestrator';

const lookup = vi.hoisted(() => vi.fn());
vi.mock('node:dns/promises', () => ({ lookup }));

const { createWebFetchTool } = await import('../src/web/web-fetch.js');
const { createHttpRequestTool } = await import('../src/web/http-request.js');

type FetchResult = { url: string; status: number; contentType: string; body: string; truncated: boolean };

beforeEach(() => {
  lookup.mockResolvedValue([{ address: '93.184.216.34' }]);
});

afterEach(() => {
  vi.unstubAllGlobals();
  lookup.mockReset();
});

describe('createWebFetchTool', () => {
  it('declares taint and the web_fetch name', () => {
    const tool = createWebFetchTool();

    expect(tool.name).toBe('web_fetch');
    expect(tool.taints).toBe(true);
  });

  it('fetches a page and returns status, content type, and body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response('<html>hi</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    ));
    const tool = createWebFetchTool();

    const result = (await tool.execute({ url: 'https://example.com/page' })) as FetchResult;

    expect(result.status).toBe(200);
    expect(result.contentType).toBe('text/html');
    expect(result.body).toBe('<html>hi</html>');
    expect(result.truncated).toBe(false);
  });

  it('truncates oversized bodies and flags it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x'.repeat(64), { status: 200 })));
    const tool = createWebFetchTool({ maxResponseBytes: 16 });

    const result = (await tool.execute({ url: 'https://example.com/big' })) as FetchResult;

    expect(result.body).toHaveLength(16);
    expect(result.truncated).toBe(true);
  });

  it('rejects hosts outside the allowlist without a network call', async () => {
    const fetchStub = vi.fn();
    vi.stubGlobal('fetch', fetchStub);
    const tool = createWebFetchTool({ allowedHosts: ['example.com'] });

    await expect(tool.execute({ url: 'https://evil.example.org/' })).rejects.toThrow(
      /not in this tool's allowed hosts/,
    );
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('rejects invalid URL arguments via the schema', async () => {
    const tool = createWebFetchTool();

    await expect(tool.execute({ url: 'not a url' })).rejects.toThrow();
  });

  it('sends the configured user agent', async () => {
    const fetchStub = vi.fn(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchStub);
    const tool = createWebFetchTool({ userAgent: 'cycgraph-test/1.0' });

    await tool.execute({ url: 'https://example.com/' });

    const init = fetchStub.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)['user-agent']).toBe('cycgraph-test/1.0');
  });
});

describe('createHttpRequestTool', () => {
  it('refuses construction without an allowlist', () => {
    expect(() => createHttpRequestTool({ allowedHosts: [] })).toThrow(ToolDefinitionError);
  });

  it('declares taint and the http_request name', () => {
    const tool = createHttpRequestTool({ allowedHosts: ['api.example.com'] });

    expect(tool.name).toBe('http_request');
    expect(tool.taints).toBe(true);
  });

  it('performs a POST with body and merged headers, defaults winning', async () => {
    const fetchStub = vi.fn(async () => new Response('{"ok":true}', { status: 201 }));
    vi.stubGlobal('fetch', fetchStub);
    const tool = createHttpRequestTool({
      allowedHosts: ['api.example.com'],
      defaultHeaders: { authorization: 'Bearer config-secret' },
    });

    const result = (await tool.execute({
      url: 'https://api.example.com/orders',
      method: 'POST',
      headers: { authorization: 'Bearer llm-attempt', 'content-type': 'application/json' },
      body: '{"sku":"a"}',
    })) as FetchResult;

    expect(result.status).toBe(201);
    const init = fetchStub.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer config-secret');
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(init.body).toBe('{"sku":"a"}');
  });

  it('overrides case-varied LLM headers with lowercase-normalized defaults', async () => {
    const fetchStub = vi.fn(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchStub);
    const tool = createHttpRequestTool({
      allowedHosts: ['api.example.com'],
      defaultHeaders: { Authorization: 'Bearer config-secret' },
    });

    await tool.execute({
      url: 'https://api.example.com/x',
      headers: { AUTHORIZATION: 'Bearer llm-attempt' },
    });

    const sent = (fetchStub.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(sent).toEqual({ authorization: 'Bearer config-secret' });
  });

  it('rejects hosts outside the allowlist', async () => {
    const tool = createHttpRequestTool({ allowedHosts: ['api.example.com'] });

    await expect(
      tool.execute({ url: 'https://other.example.com/x' }),
    ).rejects.toThrow(/not in this tool's allowed hosts/);
  });

  it('rejects methods outside the allowed set', async () => {
    const tool = createHttpRequestTool({ allowedHosts: ['api.example.com'] });

    await expect(
      tool.execute({ url: 'https://api.example.com/x', method: 'DELETE' }),
    ).rejects.toThrow(/not allowed for this tool/);
  });

  it('drops the body on GET requests', async () => {
    const fetchStub = vi.fn(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchStub);
    const tool = createHttpRequestTool({ allowedHosts: ['api.example.com'] });

    await tool.execute({ url: 'https://api.example.com/x', body: 'ignored' });

    const init = fetchStub.mock.calls[0][1] as RequestInit;
    expect(init.body).toBeUndefined();
  });
});
