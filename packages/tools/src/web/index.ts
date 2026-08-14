/**
 * Web tools: SSRF-guarded network access.
 *
 * @module web
 */

export { webFetchTool, DEFAULT_MAX_RESPONSE_BYTES } from './web-fetch.js';
export type { WebFetchToolOptions } from './web-fetch.js';
export { httpRequestTool } from './http-request.js';
export type { HttpRequestToolOptions } from './http-request.js';
export { webSearchTool } from './web-search.js';
export type { WebSearchToolOptions, WebSearchResult } from './web-search.js';
export { htmlToMarkdownTool, convertHtml } from './html-to-markdown.js';
export type { HtmlToMarkdownToolOptions, HtmlExtractMode } from './html-to-markdown.js';
export { assertUrlPublic, guardedFetch, readBodyCapped, SsrfBlockedError, MAX_REDIRECTS } from './ssrf.js';
