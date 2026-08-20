# @cycgraph/tools

## 1.1.0

### Minor Changes

- ad0f9c0: Workspace tools: `search`, `read_file`, `edit_file`, and `diagnostics` over
  one jailed directory — the surface a code-editing agent gets. Paths resolve
  through a jail that refuses escapes; reads are line-windowed with markers and
  tainted; the edit tool refuses an absent or ambiguous match rather than
  guessing. The `workspaceTools(root)` bundle arms read-before-edit as harness
  discipline: a shared session hashes content at read, and edits are refused
  for files never read or changed since. `diagnosticsTool` runs one
  caller-configured check and returns `{ clean, output }`, so an editing agent
  can see its own breakage and iterate — the agent chooses no command, only
  asks the configured question. Each tool's Zod schema is exported beside its
  factory so transports never restate parameters.

### Patch Changes

- ad0f9c0: `diagnosticsTool` accepts a `name` option so a graph can carry more than one caller-fixed probe (a typecheck and a changed-files check, say) without tool-name collisions.

## 1.0.0

### Patch Changes

- Updated dependencies [4b80adf]
- Updated dependencies [4b80adf]
- Updated dependencies [4b80adf]
- Updated dependencies [4b80adf]
- Updated dependencies [4b80adf]
- Updated dependencies [4b80adf]
- Updated dependencies [4b80adf]
- Updated dependencies [4b80adf]
- Updated dependencies [4b80adf]
- Updated dependencies [4b80adf]
- Updated dependencies [4b80adf]
- Updated dependencies [4b80adf]
- Updated dependencies [4b80adf]
  - @cycgraph/orchestrator@1.0.0

## 0.2.0

### Minor Changes

- c0a1f40: Rename every tool factory to drop the `create` prefix: `createWebFetchTool` is now `webFetchTool`, `createCalculatorTool` is now `calculatorTool`, and so on for all twelve exports across the `web`, `data`, `memory`, and `sandbox` subpaths. Update imports and call sites; the options types and behavior are unchanged.

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
