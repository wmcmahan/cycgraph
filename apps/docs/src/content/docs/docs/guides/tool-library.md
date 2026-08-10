---
title: Tool Library
description: Pre-built tools from @cycgraph/tools — SSRF-guarded web access and pure data utilities.
---

`@cycgraph/tools` is a curated package of pre-built tools. Every export is a factory returning a `defineTool()` result, so it plugs into the runner exactly like a [custom tool](/docs/guides/custom-tools/) you wrote yourself: register on `GraphRunnerOptions.tools`, declare by name.

```bash
npm install @cycgraph/tools
```

```typescript
import { GraphRunner } from '@cycgraph/orchestrator';
import { createWebFetchTool, createHttpRequestTool } from '@cycgraph/tools/web';
import { createCalculatorTool, createJsonTransformTool } from '@cycgraph/tools/data';

const runner = new GraphRunner(graph, state, {
  tools: [
    createWebFetchTool(),
    createHttpRequestTool({
      allowedHosts: ['api.example.com'],
      defaultHeaders: { authorization: `Bearer ${process.env.API_KEY}` },
    }),
    createCalculatorTool(),
    createJsonTransformTool(),
  ],
});
```

Agents and nodes then declare what they need by name: `tools: ['web_fetch', 'calculator']`.

Subpath imports keep dependencies scoped — `/web` for network tools, `/data` for pure computation.

## Web tools

The web tools are taint-tracked (`taints: true`): their results land in `state.taint_registry` with source `custom_tool` and feed the same downstream gates as MCP output. The fetch and request tools share the same defenses:

- **SSRF guard on every hop.** Private, loopback, and link-local hosts are rejected in any IP encoding (dotted, decimal, hex, IPv4-mapped IPv6), a hostname's DNS-resolved addresses are re-checked at request time to catch rebinding, and redirects are followed manually with each hop re-validated, so a public host cannot 302 the request into internal infrastructure. Five redirects maximum.
- **Size-capped bodies.** Responses stream in and stop at the cap (1 MiB by default); the result carries a `truncated` flag instead of an unbounded payload.

### web_search

Provider-pluggable search returning normalized `{ title, url, snippet }` results. Backends: Brave and Tavily; the API key is factory config and never visible to the model. This also covers the hosted-deployment gap: the default Brave MCP server runs over an `npx` stdio transport, exactly what `MCP_STDIO_DISABLED` locks down, while this tool is a plain HTTPS call.

```typescript
createWebSearchTool({ provider: 'brave', apiKey: process.env.BRAVE_API_KEY! })
```

| Option | Default | Description |
|--------|---------|-------------|
| `provider` | required | `'brave'` or `'tavily'` |
| `apiKey` | required | Provider key; throws at creation when missing |
| `maxResults` | `5` | Default and hard cap on result count |
| `timeoutMs` | `15000` | Per-call timeout |

### web_fetch

GET a public URL, return `{ url, status, contentType, body, truncated }`.

| Option | Default | Description |
|--------|---------|-------------|
| `allowedHosts` | any public host | Restrict fetches to these hostnames |
| `maxResponseBytes` | 1 MiB | Body size cap |
| `extract` | raw | `'markdown'` or `'text'`: convert HTML bodies before returning |
| `timeoutMs` | `15000` | Per-call timeout |
| `userAgent` | — | User-Agent header |
| `allowPrivateHosts` | `false` | Skip the SSRF guard. Local development only |

Set `extract: 'markdown'` for agent workflows: raw HTML burns the model's context on markup, while the converted form keeps headings, links, lists, code, and table cells. Non-HTML bodies pass through raw either way.

### http_request

Structured HTTP with methods, headers, and a body — deliberately **allowlist-first**: creating it without a non-empty `allowedHosts` throws, because an unrestricted HTTP tool in an agent's hands is a footgun. Methods default to GET and POST.

Operator-configured `defaultHeaders` are how secrets reach the request: they merge over anything the LLM supplies and never appear in the tool's schema, so an API key is never visible to the model.

### html_to_markdown

The converter behind `web_fetch`'s `extract` option, exposed as a standalone pure tool for HTML that arrives from elsewhere (an MCP tool result, a stored document). Streaming parser, no DOM: scripts, styles, and navigation chrome are dropped; unsafe link schemes (`javascript:`) render as plain text.

```typescript
{ html: '<h2>Title</h2><p>See <a href="/docs">the docs</a></p>', baseUrl: 'https://example.com' }
// → { content: '## Title\n\nSee [the docs](https://example.com/docs)' }
```

## Data tools

All pure: no network, no taint.

### current_time

The current instant as `{ iso, unixMs, timezone, human }`, localized to a requested IANA timezone. Models don't know today's date; this is the cheapest fix. Tool nondeterminism is safe for durable replay because tool results are recorded in the event log and replay replays recorded actions rather than re-executing tools.

### calculator

Evaluates arithmetic and boolean expressions with named variables using a small built-in parser — a tokenizer and recursive-descent evaluator that only ever yields a number or a boolean, with no `eval`, no `Function`, and no dependency. Non-finite results (like division by zero) and references to missing variables fail as normal tool errors the model can correct.

```typescript
{ expression: 'max(a, b) + sqrt(c)', variables: { a: 3, b: 7, c: 16 } }
// → { result: 11 }
```

### json_transform

Resolves a dot/bracket path against a JSON value (`orders[0].total`) and optionally picks a key subset from the result, element-wise on arrays. Accepts a JSON value or a JSON-encoded string, since models frequently pass stringified payloads.

```typescript
{ data: '{"orders":[{"id":"o-1","total":42}]}', path: 'orders', pick: ['total'] }
// → { result: [{ total: 42 }] }
```

### csv_parse

RFC-4180-style CSV parsing: quoted fields, doubled-quote escapes, delimiters and newlines inside quotes, CRLF endings. Header mode (the default) returns rows as objects keyed by column name. Returned rows are capped per call (`limit`, default 100) with `totalRows` and a `truncated` flag, so a large file never floods the model's context.

```typescript
{ csv: 'name,age\nAda,36', delimiter: ',' }
// → { headers: ['name','age'], rows: [{ name: 'Ada', age: '36' }], totalRows: 1, truncated: false }
```

### stats

Descriptive statistics over an array of finite numbers: count, sum, mean, median, min, max, sample standard deviation, and interpolated p25/p75/p95 percentiles. Pairs with `csv_parse` and `json_transform` for data-analysis workflows without a code interpreter.

### text_extract

Regex extraction returning each match with its index, positional groups, and named groups. The ReDoS guard is structural, which is why this belongs in the curated set: a synchronous regex can't be interrupted by a promise race, so the pattern runs in a worker thread that is **terminated** when the deadline passes (2s default), on top of pattern-length (200), input-length (100 KB), and match-count caps.

```typescript
{ text: 'from alice@example.com', pattern: '(?<user>\\w+)@(?<host>[\\w.]+)' }
// → { matches: [{ match: 'alice@example.com', index: 5, groups: [...], named: { user: 'alice', host: 'example.com' } }], count: 1 }
```

## Memory tools

`@cycgraph/tools/memory` requires `@cycgraph/memory` (an optional peer dependency, loaded only through this subpath).

### memory_search

Agent-initiated retrieval over the temporal knowledge graph. The orchestrator's `memory_query` directive injects facts passively before the prompt; this tool makes retrieval active — the agent decides mid-task that it needs to consult memory and searches by tags, seed entity ids (expanding the surrounding subgraph), or free text when an `embed` hook is configured.

```typescript
import { createMemorySearchTool } from '@cycgraph/tools/memory';

const memorySearch = createMemorySearchTool({
  store,
  index,
  scopeTags: ['graph:research-v1'],   // namespace: facts must carry one of these
  embed: (text) => embedder.embed(text),  // optional, enables free-text queries
});
```

| Option | Default | Description |
|--------|---------|-------------|
| `store` / `index` | required | The `@cycgraph/memory` store and vector index |
| `embed` | — | Embedding hook; without it free-text queries are rejected with guidance |
| `scopeTags` | — | Result filter: facts must carry at least one, whatever the model searched |
| `maxResults` | `10` | Default and hard cap per record type |
| `untrusted` | `false` | Taint-track results when the store holds externally-derived content |

Results include fact `id`s and validity timestamps. One caveat worth knowing: tool-initiated retrieval is not recorded in `state.lesson_provenance` (that field tracks prompt-injected facts), so if eval-gated learning should credit tool-driven consultation, record the returned fact ids caller-side.

## Sandbox tools

`@cycgraph/tools/sandbox` carries a WASM engine (~1 MiB), loaded only through this subpath.

### sandboxed_js

Evaluate agent-authored JavaScript against workflow data and return a JSON result. For the long tail of computation that `calculator`, `json_transform`, and `stats` can't express — custom aggregation, reshaping, small algorithms — without a code interpreter's usual risk profile.

The sandbox is two nested boundaries. The code is interpreted by QuickJS compiled to WebAssembly, so its whole world is a bounds-checked linear memory with no host imports beyond a string-only `console.log` bridge: `require`, `process`, `fetch`, `import()`, timers, and `SharedArrayBuffer` are simply absent. That engine runs in a `worker_threads` worker terminated at the deadline, because `evalCode` is synchronous and the in-engine interrupt handler needs an outside-the-engine backstop. In short: WASM decides what the code can touch (nothing), the worker decides what it can block and how it dies.

```typescript
import { createSandboxedJsTool } from '@cycgraph/tools/sandbox';

const runner = new GraphRunner(graph, state, {
  tools: [createSandboxedJsTool()],
});
```

```typescript
{ code: 'input.rows.filter(r => r.active).length', input: { rows: [/* ... */] } }
// → { result: 3, logs: [] }
```

The last expression is the result and must be JSON-serializable; optional JSON `input` is exposed as a global; `console.log` is captured into `logs`. Synchronous only — a Promise completion value is a clear error. Defaults: 2s interrupt deadline, 64 MiB memory limit, 1 MiB result cap (over-cap errors rather than truncating). Failures — syntax error, runtime exception, deadline, memory limit, oversized result — all surface as normal tool errors the model can react to.

This is the design-reviewed member of the library. For binaries or OS-level work, that's a container-backed executor or a task-shaped MCP server, not this tool.

## Related

- [Custom Tools](/docs/guides/custom-tools/): the `defineTool` primitive these factories build on
- [Tools & MCP](/docs/concepts/tools-and-mcp/): the three tool layers and how resolution works
- [Taint Tracking](/docs/concepts/taint-tracking/): what `taints: true` feeds into
- [Memory System](/docs/concepts/memory/): the knowledge graph memory_search queries
