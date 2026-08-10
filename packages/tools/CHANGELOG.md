# @cycgraph/tools

## 0.1.1

### Patch Changes

- c069711: `http_request` now lowercase-normalizes header names before merging operator `defaultHeaders` over LLM-supplied headers. Header names are case-insensitive on the wire but the previous object-spread merge was case-sensitive, so a model sending `Authorization` alongside an operator default of `authorization` produced two entries that fetch joined into one corrupt header value. Operator defaults now always win regardless of casing.

## 0.1.0

### Minor Changes

- fdf9705: Initial release of `@cycgraph/tools`: curated plug-in tools built on `defineTool()`.

  - `@cycgraph/tools/web`: `createWebFetchTool` and `createHttpRequestTool` — SSRF-guarded (any-encoding IP checks, DNS-rebinding re-check, per-hop redirect validation), size-capped streaming bodies, taint-tracked results. `http_request` is allowlist-first and keeps operator headers (API keys) out of the LLM-visible schema. Plus `createWebSearchTool` (provider-pluggable Brave/Tavily search with normalized results; works where stdio MCP is locked down) and `createHtmlToMarkdownTool` / a `web_fetch` `extract` option (streaming HTML → markdown/text extraction that drops scripts, styles, and chrome).
  - `@cycgraph/tools/data`: `createCalculatorTool` (arithmetic/boolean expressions via a built-in tokenizer + recursive-descent parser — no `eval`, no dependency), `createJsonTransformTool` (pure path/pick JSON reshaping, accepts values or JSON strings), `createCurrentTimeTool` (timezone-aware current instant), `createCsvParseTool` (RFC-4180 parsing with row-capped output), `createStatsTool` (descriptive statistics with interpolated percentiles), and `createTextExtractTool` (regex extraction with a worker-terminating ReDoS guard plus pattern/input/match caps).
  - `@cycgraph/tools/memory`: `createMemorySearchTool` — agent-initiated retrieval over the `@cycgraph/memory` knowledge graph by tags, seed entities, or free text via an `embed` hook; namespace `scopeTags` enforced as a result filter; fact ids returned for caller-side outcome attribution. `@cycgraph/memory` is an optional peer dependency loaded only through this subpath.
  - `@cycgraph/tools/sandbox`: `createSandboxedJsTool` — a code-interpreter tool that evaluates agent-authored JavaScript in a QuickJS-in-WASM sandbox (no filesystem, network, timers, or modules; only a string-only console bridge) inside a terminatable worker. Synchronous evaluation, JSON `input` global, captured logs, and deadline/memory/result caps. Carries the QuickJS WASM engine so it loads only via this subpath.
