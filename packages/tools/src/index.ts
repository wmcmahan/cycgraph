/**
 * @cycgraph/tools — curated plug-in tools for @cycgraph/orchestrator.
 *
 * Every export is a factory returning a `defineTool()` result; register it
 * on `GraphRunnerOptions.tools` and declare the tool by name in agent or
 * node config. Subpath imports keep dependencies scoped:
 * `@cycgraph/tools/web` for network tools, `@cycgraph/tools/data` for pure
 * computation.
 *
 * @module index
 */

export {
  webFetchTool,
  httpRequestTool,
  webSearchTool,
  htmlToMarkdownTool,
  convertHtml,
  assertUrlPublic,
  guardedFetch,
  readBodyCapped,
  SsrfBlockedError,
  MAX_REDIRECTS,
  DEFAULT_MAX_RESPONSE_BYTES,
} from './web/index.js';
export type {
  WebFetchToolOptions,
  HttpRequestToolOptions,
  WebSearchToolOptions,
  WebSearchResult,
  HtmlToMarkdownToolOptions,
  HtmlExtractMode,
} from './web/index.js';

export {
  calculatorTool,
  jsonTransformTool,
  currentTimeTool,
  csvParseTool,
  parseCsv,
  statsTool,
  textExtractTool,
} from './data/index.js';
export type {
  CalculatorToolOptions,
  JsonTransformToolOptions,
  CurrentTimeToolOptions,
  CsvParseToolOptions,
  StatsToolOptions,
  TextExtractToolOptions,
  ExtractedMatch,
} from './data/index.js';

// memory and sandbox tools are deliberately NOT re-exported here: @cycgraph/memory
// is an optional peer dependency, and the sandbox subpath carries the QuickJS WASM
// engine — both are reached only via their subpaths (`@cycgraph/tools/memory`,
// `@cycgraph/tools/sandbox`) so root-barrel consumers never load them.
