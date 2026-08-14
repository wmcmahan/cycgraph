/**
 * Tests for the Tier 1 additions: current_time (src/data/current-time.ts),
 * web_search (src/web/web-search.ts), and the html_to_markdown converter +
 * tool (src/web/html-to-markdown.ts) including the web_fetch extract
 * option. Network fully stubbed.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { ToolDefinitionError } from '@cycgraph/orchestrator';
import { currentTimeTool } from '../src/data/current-time.js';
import { convertHtml, htmlToMarkdownTool } from '../src/web/html-to-markdown.js';

const lookup = vi.hoisted(() => vi.fn());
vi.mock('node:dns/promises', () => ({ lookup }));

const { webSearchTool } = await import('../src/web/web-search.js');
const { webFetchTool } = await import('../src/web/web-fetch.js');

beforeEach(() => {
  lookup.mockResolvedValue([{ address: '93.184.216.34' }]);
});

afterEach(() => {
  vi.unstubAllGlobals();
  lookup.mockReset();
});

describe('currentTimeTool', () => {
  type TimeResult = { iso: string; unixMs: number; timezone: string; human: string };

  it('returns the current instant in ISO, epoch, and human forms', async () => {
    const before = Date.now();
    const result = (await currentTimeTool().execute({})) as TimeResult;

    expect(result.unixMs).toBeGreaterThanOrEqual(before);
    expect(new Date(result.iso).getTime()).toBe(result.unixMs);
    expect(result.timezone).toBe('UTC');
    expect(result.human.length).toBeGreaterThan(0);
  });

  it('localizes to a requested IANA timezone', async () => {
    const result = (await currentTimeTool().execute({
      timezone: 'America/New_York',
    })) as TimeResult;

    expect(result.timezone).toBe('America/New_York');
  });

  it('uses the factory default timezone when none is requested', async () => {
    const result = (await currentTimeTool({ timezone: 'Europe/Berlin' }).execute({})) as TimeResult;

    expect(result.timezone).toBe('Europe/Berlin');
  });

  it('rejects an unknown timezone', async () => {
    await expect(
      currentTimeTool().execute({ timezone: 'Mars/Olympus_Mons' }),
    ).rejects.toThrow(/Unknown timezone/);
  });
});

describe('webSearchTool', () => {
  type SearchResult = {
    provider: string;
    query: string;
    results: Array<{ title: string; url: string; snippet: string }>;
  };

  it('refuses construction without an API key', () => {
    expect(() => webSearchTool({ provider: 'brave', apiKey: '' })).toThrow(
      ToolDefinitionError,
    );
  });

  it('declares taint and the web_search name', () => {
    const tool = webSearchTool({ provider: 'brave', apiKey: 'k' });

    expect(tool.name).toBe('web_search');
    expect(tool.taints).toBe(true);
  });

  it('normalizes Brave results and sends the subscription token', async () => {
    const fetchStub = vi.fn(async () =>
      new Response(
        JSON.stringify({
          web: { results: [{ title: 'T', url: 'https://t.example.com', description: 'D' }] },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchStub);
    const tool = webSearchTool({ provider: 'brave', apiKey: 'brave-key' });

    const result = (await tool.execute({ query: 'cycgraph' })) as SearchResult;

    expect(result.provider).toBe('brave');
    expect(result.results).toEqual([
      { title: 'T', url: 'https://t.example.com', snippet: 'D' },
    ]);
    const init = fetchStub.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)['x-subscription-token']).toBe('brave-key');
  });

  it('normalizes Tavily results from the content field', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(
        JSON.stringify({ results: [{ title: 'T', url: 'https://t.example.com', content: 'C' }] }),
        { status: 200 },
      ),
    ));
    const tool = webSearchTool({ provider: 'tavily', apiKey: 'tav-key' });

    const result = (await tool.execute({ query: 'cycgraph' })) as SearchResult;

    expect(result.results[0].snippet).toBe('C');
  });

  it('caps requested result counts at the factory maximum', async () => {
    const fetchStub = vi.fn(async () => new Response(JSON.stringify({ web: { results: [] } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchStub);
    const tool = webSearchTool({ provider: 'brave', apiKey: 'k', maxResults: 3 });

    await tool.execute({ query: 'q', maxResults: 20 });

    const calledUrl = new URL(fetchStub.mock.calls[0][0] as URL | string);
    expect(calledUrl.searchParams.get('count')).toBe('3');
  });

  it('surfaces provider errors as tool failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 429 })));
    const tool = webSearchTool({ provider: 'brave', apiKey: 'k' });

    await expect(tool.execute({ query: 'q' })).rejects.toThrow(/status 429/);
  });

  it('surfaces Tavily errors as tool failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    const tool = webSearchTool({ provider: 'tavily', apiKey: 'k' });

    await expect(tool.execute({ query: 'q' })).rejects.toThrow(/status 500/);
  });

  it('defaults missing result fields to empty strings', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ web: { results: [{}] } }), { status: 200 }),
    ));
    const tool = webSearchTool({ provider: 'brave', apiKey: 'k' });

    const result = (await tool.execute({ query: 'q' })) as SearchResult;

    expect(result.results).toEqual([{ title: '', url: '', snippet: '' }]);
  });

  it('handles a Tavily payload with no results array', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })));
    const tool = webSearchTool({ provider: 'tavily', apiKey: 'k' });

    const result = (await tool.execute({ query: 'q' })) as SearchResult;

    expect(result.results).toEqual([]);
  });
});

describe('convertHtml', () => {
  it('converts headings, paragraphs, and links to markdown', () => {
    const html = '<h2>Title</h2><p>See <a href="/docs">the docs</a> now.</p>';

    expect(convertHtml(html, { baseUrl: 'https://example.com' })).toBe(
      '## Title\n\nSee [the docs](https://example.com/docs) now.',
    );
  });

  it('drops scripts, styles, and navigation chrome', () => {
    const html =
      '<nav>Menu</nav><script>evil()</script><style>.x{}</style><p>Content</p><footer>Legal</footer>';

    expect(convertHtml(html)).toBe('Content');
  });

  it('renders unordered and ordered lists', () => {
    const html = '<ul><li>alpha</li><li>beta</li></ul><ol><li>one</li><li>two</li></ol>';

    expect(convertHtml(html)).toBe('- alpha\n\n- beta\n\n1. one\n\n2. two');
  });

  it('fences pre blocks and backticks inline code', () => {
    const html = '<p>Run <code>npm test</code>:</p><pre>line1\nline2</pre>';

    expect(convertHtml(html)).toBe('Run `npm test`:\n\n```\nline1\nline2\n```');
  });

  it('drops unsafe link schemes but keeps their text', () => {
    const html = '<p><a href="javascript:alert(1)">click me</a></p>';

    expect(convertHtml(html)).toBe('click me');
  });

  it('joins table cells with pipes', () => {
    const html = '<table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>';

    expect(convertHtml(html)).toBe('a | b\n\nc | d');
  });

  it('renders prose without syntax in text mode', () => {
    const html = '<h1>Title</h1><p>See <a href="https://example.com/x">docs</a>.</p>';

    expect(convertHtml(html, { mode: 'text' })).toBe('Title\n\nSee docs.');
  });
});

describe('htmlToMarkdownTool', () => {
  it('converts via the tool surface', async () => {
    const tool = htmlToMarkdownTool();

    const result = (await tool.execute({ html: '<h1>Hi</h1>' })) as { content: string };

    expect(result.content).toBe('# Hi');
    expect(tool.taints).toBe(false);
  });

  it('rejects oversized input', async () => {
    const tool = htmlToMarkdownTool({ maxInputBytes: 10 });

    await expect(tool.execute({ html: '<p>12345678901</p>' })).rejects.toThrow(/exceeds/);
  });
});

describe('webFetchTool extract option', () => {
  function htmlResponse(body: string) {
    return new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });
  }

  it('converts HTML bodies to markdown when extract is set', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => htmlResponse('<h1>Page</h1><p>Body</p>')));
    const tool = webFetchTool({ extract: 'markdown' });

    const result = (await tool.execute({ url: 'https://example.com/' })) as { body: string };

    expect(result.body).toBe('# Page\n\nBody');
  });

  it('leaves non-HTML bodies raw even when extract is set', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response('{"a":1}', { status: 200, headers: { 'content-type': 'application/json' } }),
    ));
    const tool = webFetchTool({ extract: 'markdown' });

    const result = (await tool.execute({ url: 'https://example.com/api' })) as { body: string };

    expect(result.body).toBe('{"a":1}');
  });

  it('returns raw HTML when extract is not configured', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => htmlResponse('<h1>Page</h1>')));
    const tool = webFetchTool();

    const result = (await tool.execute({ url: 'https://example.com/' })) as { body: string };

    expect(result.body).toBe('<h1>Page</h1>');
  });
});
