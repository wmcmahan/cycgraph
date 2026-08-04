/**
 * Web tools: SSRF-guarded network access.
 *
 * @module web
 */

export { createWebFetchTool, DEFAULT_MAX_RESPONSE_BYTES } from './web-fetch.js';
export type { WebFetchToolOptions } from './web-fetch.js';
export { createHttpRequestTool } from './http-request.js';
export type { HttpRequestToolOptions } from './http-request.js';
export { createWebSearchTool } from './web-search.js';
export type { WebSearchToolOptions, WebSearchResult } from './web-search.js';
export { createHtmlToMarkdownTool, convertHtml } from './html-to-markdown.js';
export type { HtmlToMarkdownToolOptions, HtmlExtractMode } from './html-to-markdown.js';
export { assertUrlPublic, guardedFetch, readBodyCapped, SsrfBlockedError, MAX_REDIRECTS } from './ssrf.js';
