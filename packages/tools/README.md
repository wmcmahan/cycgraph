<div align="center">

# @cycgraph/tools

**Curated plug-in tools for @cycgraph/orchestrator. SSRF-guarded web access and pure data utilities, built on `defineTool`.**

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](../../LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-339933?logo=node.js&logoColor=white)](https://nodejs.org)

[📚 Documentation](https://flattop.io/docs/guides/tool-library/) &nbsp;·&nbsp; [🔧 Custom tools guide](https://flattop.io/docs/guides/custom-tools/) &nbsp;·&nbsp; [📖 Tools & MCP concepts](https://flattop.io/docs/concepts/tools-and-mcp/)

</div>

---

Pre-built tools for cycgraph workflows. Every export is a factory returning a `defineTool()` result: register it on `GraphRunnerOptions.tools`, declare the tool by name in agent or node config, and the orchestrator handles schema validation, timeouts, and taint tracking.

This is a curated set, not a grab-bag. Every tool ships with Zod-validated inputs, an explicit taint declaration, tests, and a maintenance owner. Tools that touch the network are SSRF-guarded and size-capped by construction.

## Install

```bash
npm install @cycgraph/tools @cycgraph/orchestrator
```

Subpath imports keep dependencies scoped:

```typescript
import { createWebFetchTool, createHttpRequestTool, createWebSearchTool } from '@cycgraph/tools/web';
import { createCalculatorTool, createJsonTransformTool, createCurrentTimeTool } from '@cycgraph/tools/data';
import { createMemorySearchTool } from '@cycgraph/tools/memory';
import { createSandboxedJsTool } from '@cycgraph/tools/sandbox';
```

## Quick start

```typescript
import { GraphRunner } from '@cycgraph/orchestrator';
import { createWebFetchTool } from '@cycgraph/tools/web';
import { createCalculatorTool } from '@cycgraph/tools/data';

const runner = new GraphRunner(graph, state, {
  tools: [createWebFetchTool(), createCalculatorTool()],
});
```

Agents declare the tools by name:

```typescript
tools: ['web_fetch', 'calculator']
```

## The tools

### `web_search` — `@cycgraph/tools/web`

Provider-pluggable search (Brave, Tavily) with normalized `{ title, url, snippet }` results. Taint-tracked; the API key is factory config the model never sees. Works in hosted deployments where the stdio MCP transport is disabled.

### `web_fetch` — `@cycgraph/tools/web`

GET a public URL and return its body as text. Taint-tracked (`taints: true`).

- **SSRF guard on every hop**: private/loopback/link-local hosts are rejected in any IP encoding, DNS-resolved addresses are re-checked (rebinding), and redirects are followed manually so each hop is validated. Max 5 redirects.
- **Size-capped**: bodies stream in and stop at the cap (1 MiB default); the result carries a `truncated` flag.
- Options: `allowedHosts`, `maxResponseBytes`, `extract` ('markdown' | 'text' conversion of HTML bodies), `timeoutMs` (15s default), `userAgent`, `allowPrivateHosts` (dev only).

### `html_to_markdown` — `@cycgraph/tools/web`

Streaming HTML → markdown/text extraction (no DOM): headings, links, lists, code, and table cells survive; scripts, styles, and navigation chrome are dropped. Also available as `web_fetch`'s `extract` option.

### `http_request` — `@cycgraph/tools/web`

Structured HTTP against a fixed set of hosts. Taint-tracked.

- **Allowlist-first**: creating it without a non-empty `allowedHosts` throws. Methods default to GET/POST.
- **Secrets stay config-side**: operator `defaultHeaders` (API keys) merge over LLM-supplied headers and never appear in the tool schema.
- Same SSRF guard, redirect discipline, and size cap as `web_fetch`.

### `current_time` — `@cycgraph/tools/data`

The current instant as `{ iso, unixMs, timezone, human }`, localized to a requested IANA timezone. Safe under durable replay: tool results are recorded in the event log, and replay replays actions rather than re-executing tools.

### `calculator` — `@cycgraph/tools/data`

Arithmetic and boolean expressions with named variables, evaluated by a small built-in parser (tokenizer + recursive descent) that yields only numbers or booleans. No `eval`, no dependency. Pure, untainted.

### `json_transform` — `@cycgraph/tools/data`

Extract and reshape JSON: resolve a dot/bracket path (`orders[0].total`) and optionally pick a key subset. Accepts a JSON value or a JSON string. Pure, untainted.

### `csv_parse` — `@cycgraph/tools/data`

RFC-4180-style CSV parsing (quoted fields, escaped quotes, delimiters/newlines inside quotes, CRLF). Header mode returns object rows; output is row-capped with `totalRows` + `truncated` so large files never flood the context.

### `stats` — `@cycgraph/tools/data`

Descriptive statistics: count, sum, mean, median, min, max, sample stdDev, and interpolated p25/p75/p95.

### `text_extract` — `@cycgraph/tools/data`

Regex extraction with a structural ReDoS guard: the pattern runs in a worker thread terminated at the deadline (a promise race can't interrupt synchronous backtracking), plus pattern/input/match caps. Returns matches with indexes, positional groups, and named groups.

### `memory_search` — `@cycgraph/tools/memory`

Agent-initiated retrieval over the `@cycgraph/memory` temporal knowledge graph: search by tags, seed entity ids (subgraph expansion), or free text via an `embed` hook. `scopeTags` namespace-restrict results regardless of what the model searched; fact ids come back for caller-side outcome attribution. Requires `@cycgraph/memory` (optional peer dependency, loaded only via this subpath).

### `sandboxed_js` — `@cycgraph/tools/sandbox`

Evaluate agent-authored JavaScript against workflow data and return a JSON result. Two nested boundaries: QuickJS-in-WASM (no fs/network/timers/modules; only a string-only `console.log` bridge) inside a `worker_threads` worker terminated at the deadline. Synchronous; last expression is the result; optional JSON `input` global. Defaults 2s deadline / 64 MiB / 1 MiB result cap. Carries the QuickJS WASM engine, so it lives behind its own subpath.

## Development

```bash
npm test --workspace=packages/tools
npm run build --workspace=packages/tools
npm run lint --workspace=packages/tools
```

## Related

- [`@cycgraph/orchestrator`](../orchestrator/) — the engine and the `defineTool` primitive
- [Custom tools guide](https://flattop.io/docs/guides/custom-tools/) — build your own
- [Tools & MCP](https://flattop.io/docs/concepts/tools-and-mcp/) — the three tool layers

## Contributing

Issues and PRs welcome on [GitHub](https://github.com/wmcmahan/cycgraph). New tools need tests, a taint declaration, and a maintenance owner — see [CONTRIBUTING.md](https://github.com/wmcmahan/cycgraph/blob/main/CONTRIBUTING.md).

## License

[Apache 2.0](https://github.com/wmcmahan/cycgraph/blob/main/LICENSE).
