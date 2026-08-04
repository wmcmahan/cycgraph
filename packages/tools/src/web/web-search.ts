/**
 * web_search — provider-pluggable web search
 *
 * Native search without the default Brave MCP server's `npx` stdio
 * transport, so it works in hosted deployments where stdio MCP is locked
 * down (`MCP_STDIO_DISABLED`). The API key is factory config, never visible
 * to the model. Results are external content, so the tool is taint-tracked.
 *
 * Providers return a normalized `{ title, url, snippet }` result shape.
 *
 * @module web/web-search
 */

import { z } from 'zod';
import { defineTool, type DefinedTool, ToolDefinitionError } from '@cycgraph/orchestrator';

/** A single normalized search hit. */
export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** Options for {@link createWebSearchTool}. */
export interface WebSearchToolOptions {
  /** Search backend. */
  provider: 'brave' | 'tavily';
  /** Provider API key. Required; stays config-side. */
  apiKey: string;
  /** Default (and maximum) number of results. @default 5 */
  maxResults?: number;
  /** Per-call timeout forwarded to defineTool. @default 15000 */
  timeoutMs?: number;
}

async function braveSearch(
  query: string,
  count: number,
  apiKey: string,
): Promise<WebSearchResult[]> {
  const url = new URL('https://api.search.brave.com/res/v1/web/search');
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(count));

  const response = await fetch(url, {
    headers: { accept: 'application/json', 'x-subscription-token': apiKey },
  });
  if (!response.ok) {
    throw new Error(`Brave search failed with status ${response.status}`);
  }

  const payload = (await response.json()) as {
    web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
  };
  return (payload.web?.results ?? []).slice(0, count).map((r) => ({
    title: r.title ?? '',
    url: r.url ?? '',
    snippet: r.description ?? '',
  }));
}

async function tavilySearch(
  query: string,
  count: number,
  apiKey: string,
): Promise<WebSearchResult[]> {
  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ query, max_results: count }),
  });
  if (!response.ok) {
    throw new Error(`Tavily search failed with status ${response.status}`);
  }

  const payload = (await response.json()) as {
    results?: Array<{ title?: string; url?: string; content?: string }>;
  };
  return (payload.results ?? []).slice(0, count).map((r) => ({
    title: r.title ?? '',
    url: r.url ?? '',
    snippet: r.content ?? '',
  }));
}

/**
 * Create the `web_search` tool.
 *
 * @throws {ToolDefinitionError} When `apiKey` is missing.
 */
export function createWebSearchTool(options: WebSearchToolOptions): DefinedTool {
  if (!options.apiKey) {
    throw new ToolDefinitionError('web_search requires an apiKey for the configured provider');
  }
  const maxResults = options.maxResults ?? 5;

  return defineTool({
    name: 'web_search',
    description:
      'Search the web and return results as { title, url, snippet }. ' +
      'Use web_fetch to read the full content of a result.',
    parameters: z.object({
      query: z.string().min(1).max(500).describe('The search query'),
      maxResults: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe(`Number of results (default ${maxResults})`),
    }),
    taints: true,
    timeoutMs: options.timeoutMs ?? 15_000,
    execute: async ({ query, maxResults: requested }) => {
      const count = Math.min(requested ?? maxResults, maxResults);
      const results =
        options.provider === 'brave'
          ? await braveSearch(query, count, options.apiKey)
          : await tavilySearch(query, count, options.apiKey);

      return { provider: options.provider, query, results };
    },
  });
}
