/**
 * http_request — allowlist-first structured HTTP
 *
 * A generic HTTP tool is a bigger footgun than a page fetch, so this one is
 * allowlist-first: creating it without a non-empty `allowedHosts` throws.
 * Operator-configured `defaultHeaders` (API keys and the like) are merged
 * over LLM-supplied headers and never appear in the tool's schema, so
 * secrets stay config-side. Results are taint-tracked.
 *
 * @module web/http-request
 */

import { z } from 'zod';
import { defineTool, type DefinedTool, ToolDefinitionError } from '@cycgraph/orchestrator';
import { guardedFetch, readBodyCapped } from './ssrf.js';
import { DEFAULT_MAX_RESPONSE_BYTES } from './web-fetch.js';

const ALL_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
type HttpMethod = (typeof ALL_METHODS)[number];

/** Options for {@link httpRequestTool}. */
export interface HttpRequestToolOptions {
  /** Hostnames this tool may call (exact match). Required and non-empty. */
  allowedHosts: string[];
  /** Methods the LLM may use. @default ['GET', 'POST'] */
  allowedMethods?: HttpMethod[];
  /** Headers merged over LLM-supplied ones on every request (e.g. auth). */
  defaultHeaders?: Record<string, string>;
  /** Cap on response body bytes. @default 1 MiB */
  maxResponseBytes?: number;
  /** Per-call timeout forwarded to defineTool. @default 15000 */
  timeoutMs?: number;
  /** Skip the SSRF guard for local development. Never enable in production. */
  allowPrivateHosts?: boolean;
}

/**
 * Create the `http_request` tool for a fixed set of hosts.
 *
 * @throws {ToolDefinitionError} When `allowedHosts` is missing or empty.
 */
export function httpRequestTool(options: HttpRequestToolOptions): DefinedTool {
  if (!options.allowedHosts || options.allowedHosts.length === 0) {
    throw new ToolDefinitionError(
      'http_request requires a non-empty allowedHosts list — an unrestricted HTTP tool is not supported',
    );
  }
  const methods = options.allowedMethods ?? (['GET', 'POST'] as HttpMethod[]);
  const maxBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;

  return defineTool({
    name: 'http_request',
    description:
      `Make an HTTP request to an allowed host (${options.allowedHosts.join(', ')}). ` +
      `Allowed methods: ${methods.join(', ')}. Responses are returned as text, size-capped.`,
    parameters: z.object({
      url: z.url().describe('Absolute http(s) URL on an allowed host'),
      method: z.enum(ALL_METHODS).optional().describe('HTTP method (default GET)'),
      headers: z.record(z.string(), z.string()).optional().describe('Request headers'),
      body: z.string().optional().describe('Request body (string; JSON-encode objects)'),
    }),
    taints: true,
    timeoutMs: options.timeoutMs ?? 15_000,
    execute: async ({ url, method, headers, body }) => {
      const host = new URL(url).hostname;
      if (!options.allowedHosts.includes(host)) {
        throw new Error(`Host "${host}" is not in this tool's allowed hosts`);
      }
      const effectiveMethod = method ?? 'GET';
      if (!methods.includes(effectiveMethod)) {
        throw new Error(`Method "${effectiveMethod}" is not allowed for this tool`);
      }

      // Lowercase-normalize before merging: header names are case-insensitive
      // on the wire but object spread is case-sensitive, so an LLM-supplied
      // `Authorization` would SURVIVE alongside the operator's `authorization`
      // default and fetch would join them into one corrupt header value.
      const merged: Record<string, string> = {};
      for (const [name, value] of Object.entries(headers ?? {})) {
        merged[name.toLowerCase()] = value;
      }
      for (const [name, value] of Object.entries(options.defaultHeaders ?? {})) {
        merged[name.toLowerCase()] = value;
      }

      const { response, finalUrl } = await guardedFetch(
        url,
        {
          method: effectiveMethod,
          headers: merged,
          ...(body !== undefined && effectiveMethod !== 'GET' ? { body } : {}),
        },
        options.allowPrivateHosts,
      );
      const read = await readBodyCapped(response, maxBytes);

      return {
        url: finalUrl,
        status: response.status,
        contentType: response.headers.get('content-type') ?? '',
        body: read.body,
        truncated: read.truncated,
      };
    },
  });
}
