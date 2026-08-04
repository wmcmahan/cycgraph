/**
 * web_fetch — SSRF-guarded page fetch
 *
 * GET a URL and return its body as text. Every hop (including redirects)
 * passes the SSRF guard, the body is size-capped as it streams, and the
 * result is taint-tracked (`taints: true`) because page content is
 * external data.
 *
 * @module web/web-fetch
 */

import { z } from 'zod';
import { defineTool, type DefinedTool } from '@cycgraph/orchestrator';
import { guardedFetch, readBodyCapped } from './ssrf.js';
import { convertHtml, type HtmlExtractMode } from './html-to-markdown.js';

/** Default cap on fetched body size: 1 MiB of text is plenty for an LLM. */
export const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;

/** Options for {@link createWebFetchTool}. */
export interface WebFetchToolOptions {
  /** Restrict fetches to these hostnames (exact match). Omit for any public host. */
  allowedHosts?: string[];
  /** Cap on response body bytes. @default 1 MiB */
  maxResponseBytes?: number;
  /** Per-call timeout forwarded to defineTool. @default 15000 */
  timeoutMs?: number;
  /** Skip the SSRF guard for local development. Never enable in production. */
  allowPrivateHosts?: boolean;
  /** User-Agent header sent with each request. */
  userAgent?: string;
  /**
   * Convert HTML bodies before returning them: `'markdown'` keeps headings,
   * links, lists, and code; `'text'` is prose only. Applied only when the
   * response content type is HTML; other bodies pass through raw. Omit for
   * raw bodies.
   */
  extract?: HtmlExtractMode;
}

/**
 * Create the `web_fetch` tool. Register the result on
 * `GraphRunnerOptions.tools` and declare `'web_fetch'` on any agent or node.
 */
export function createWebFetchTool(options: WebFetchToolOptions = {}): DefinedTool {
  const maxBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;

  return defineTool({
    name: 'web_fetch',
    description:
      'Fetch a public web page over HTTP GET and return its body as text. ' +
      'Responses are size-capped; binary content is not supported.',
    parameters: z.object({
      url: z.url().describe('Absolute http(s) URL to fetch'),
    }),
    taints: true,
    timeoutMs: options.timeoutMs ?? 15_000,
    execute: async ({ url }) => {
      const host = new URL(url).hostname;
      if (options.allowedHosts && !options.allowedHosts.includes(host)) {
        throw new Error(`Host "${host}" is not in this tool's allowed hosts`);
      }

      const { response, finalUrl } = await guardedFetch(
        url,
        { method: 'GET', headers: options.userAgent ? { 'user-agent': options.userAgent } : {} },
        options.allowPrivateHosts,
      );
      const { body, truncated } = await readBodyCapped(response, maxBytes);
      const contentType = response.headers.get('content-type') ?? '';

      const extracted =
        options.extract && contentType.includes('html')
          ? convertHtml(body, { mode: options.extract, baseUrl: finalUrl })
          : body;

      return {
        url: finalUrl,
        status: response.status,
        contentType,
        body: extracted,
        truncated,
      };
    },
  });
}
