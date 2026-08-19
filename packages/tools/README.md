<div align="center">

# @cycgraph/tools

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](../../LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-339933?logo=node.js&logoColor=white)](https://nodejs.org)

</div>

Tool library for [@cycgraph/orchestrator](https://github.com/wmcmahan/cycgraph/tree/main/packages/orchestrator). These are optional dependencies that provide tools that can be used by agents.

## Install

```bash
npm install @cycgraph/tools
```

Subpath imports keep dependencies scoped:

```typescript
import { webFetchTool, httpRequestTool, webSearchTool } from '@cycgraph/tools/web';
import { calculatorTool, jsonTransformTool, currentTimeTool } from '@cycgraph/tools/data';
import { memorySearchTool } from '@cycgraph/tools/memory';
import { sandboxedJsTool } from '@cycgraph/tools/sandbox';
import { workspaceTools } from '@cycgraph/tools/workspace';
```

## Quick start

```typescript
import { GraphRunner } from '@cycgraph/orchestrator';
import { webFetchTool } from '@cycgraph/tools/web';
import { calculatorTool } from '@cycgraph/tools/data';

const runner = new GraphRunner(graph, state, {
  tools: [webFetchTool(), calculatorTool()],
});
```

Agents declare the tools by name:

```typescript
tools: ['web_fetch', 'calculator']
```

## The tools

### Web Search

```typescript
import { webSearchTool } from '@cycgraph/tools/web';

const search = webSearchTool({
  provider: 'brave',
  apiKey: process.env.BRAVE_API_KEY!,
  maxResults: 10,
  timeoutMs: 15_000,
});
```

The model calls it with `{ query }`.

Provider-pluggable search (Brave, Tavily) with normalized results. The API key stays config-side — it is never part of the model-facing schema.

### Web Fetch

```typescript
import { webFetchTool } from '@cycgraph/tools/web';

const fetch = webFetchTool({
  allowedHosts: ['example.com'],
  maxResponseBytes: 1024 * 1024,
  extract: 'markdown',
  timeoutMs: 15_000,
  userAgent: 'My Agent',
});
```

The model calls it with `{ url }` — which URL to fetch is the model's decision; which hosts it may reach is yours.

GET a public URL and return its body as text.

SSRF-protected: private/loopback/link-local hosts are rejected in any IP encoding, DNS-resolved addresses are re-checked (rebinding), and redirects are followed manually so each hop is validated. Max 5 redirects.

### HTML to Markdown

```typescript
import { htmlToMarkdownTool } from '@cycgraph/tools/web';

const markdown = htmlToMarkdownTool({
  maxInputBytes: 5 * 1024 * 1024,
  timeoutMs: 10_000,
});
```

The model calls it with `{ html, mode?, baseUrl? }` — `mode` is `'markdown'` (default) or `'text'`, and `baseUrl` resolves relative links.

### HTTP Request

```typescript
import { httpRequestTool } from '@cycgraph/tools/web';

const request = httpRequestTool({
  allowedHosts: ['api.example.com'],
  allowedMethods: ['GET', 'POST'],
  defaultHeaders: { authorization: `Bearer ${process.env.API_TOKEN}` },
  maxResponseBytes: 1024 * 1024,
  timeoutMs: 15_000,
});
```

The model calls it with `{ url, method?, headers?, body? }`. `allowedHosts` is required and non-empty — this tool exists for a fixed set of APIs, and `defaultHeaders` merge over the model's headers so credentials stay config-side.

### Current Time

```typescript
import { currentTimeTool } from '@cycgraph/tools/data';

const now = currentTimeTool({
  timezone: 'America/New_York',
});
```
### Calculator

```typescript
import { calculatorTool } from '@cycgraph/tools/data';

const calc = calculatorTool();
```

The model calls it with `{ expression, variables? }` — e.g. `{ expression: 'x + y * z', variables: { x: 1, y: 2, z: 3 } }`.

### JSON Transform

```typescript
import { jsonTransformTool } from '@cycgraph/tools/data';

const transform = jsonTransformTool();
```

The model calls it with `{ data, path?, keys? }` — e.g. `{ data: { orders: [{ id: 1, total: 100 }] }, path: 'orders[0].total' }`. `data` accepts a JSON value or a JSON-encoded string.

Extract and reshape JSON. Resolve a dot/bracket path and optionally pick a key subset. Accepts a JSON value or a JSON string.

### CSV Parse

```typescript
import { csvParseTool } from '@cycgraph/tools/data';

const csv = csvParseTool({ maxRows: 1000 });
```

The model calls it with `{ csv, delimiter?, hasHeader? }` — e.g. `{ csv: 'id,name\n1,Alice\n2,Bob', hasHeader: true }`.

### Stats

```typescript
import { statsTool } from '@cycgraph/tools/data';

const stats = statsTool();
```

The model calls it with `{ values }` — an array of finite numbers.

Descriptive statistics: count, sum, mean, median, min, max, sample stdDev, and interpolated p25/p75/p95.

### Text Extract

```typescript
import { textExtractTool } from '@cycgraph/tools/data';

const extract = textExtractTool({
  regexTimeoutMs: 2000,
  maxMatches: 100,
});
```

The model calls it with `{ text, pattern, flags? }` — e.g. `{ text: 'order_123 total $100', pattern: 'order_(\\d+)' }` (no surrounding slashes; escape backslashes when authoring the pattern in a string literal).

Regex extraction with a structural ReDoS guard: the pattern runs in a worker thread terminated at the deadline (a promise race can't interrupt synchronous backtracking), plus pattern/input/match caps. Returns matches with indexes, positional groups, and named groups.

### Memory Search

```typescript
import { memorySearchTool } from '@cycgraph/tools/memory';
import { InMemoryMemoryStore, InMemoryMemoryIndex } from '@cycgraph/memory';

const search = memorySearchTool({
  store: new InMemoryMemoryStore(),
  index: new InMemoryMemoryIndex(),
  scopeTags: ['customer-123'],
  maxResults: 10,
});
```

The model calls it with `{ query?, entityIds?, tags?, limit? }` — e.g. `{ tags: ['order'] }`. Free-text `query` needs the `embed` hook, and is rejected without one.

Agent-initiated retrieval over the `@cycgraph/memory` temporal knowledge graph: search by tags, seed entity ids (subgraph expansion), or free text via an `embed` hook. `scopeTags` namespace-restrict results regardless of what the model searched; fact ids come back for caller-side outcome attribution. Requires `@cycgraph/memory` (optional peer dependency, loaded only via this subpath).

### Sandboxed JS

```typescript
import { sandboxedJsTool } from '@cycgraph/tools/sandbox';

const sandbox = sandboxedJsTool({
  deadlineMs: 2000,
  memoryLimitBytes: 64 * 1024 * 1024,
  maxResultBytes: 1024 * 1024,
});
```

The model calls it with `{ code, input? }` — e.g. `{ code: 'input.x + input.y * 2', input: { x: 1, y: 2 } }`. The last expression is the result; there is no `return` at the top level.

Evaluate agent-authored JavaScript against workflow data and return a JSON result. Two nested boundaries: QuickJS-in-WASM (no fs/network/timers/modules; only a string-only `console.log` bridge) inside a `worker_threads` worker terminated at the deadline. Synchronous; last expression is the result; optional JSON `input` global. Defaults 2s deadline / 64 MiB / 1 MiB result cap. Carries the QuickJS WASM engine, so it lives behind its own subpath.

### Workspace: Search, Read File, Edit File, Diagnostics

```typescript
import { workspaceTools } from '@cycgraph/tools/workspace';

const runner = new GraphRunner(graph, state, {
  tools: workspaceTools('/path/to/disposable/clone'),
});
```

Or individually, when a surface needs its own limits:

```typescript
import { searchTool, readFileTool, editFileTool } from '@cycgraph/tools/workspace';

const tools = [
  searchTool({ root, maxHits: 20 }),
  readFileTool({ root, maxFileBytes: 256 * 1024 }),
  editFileTool({ root }),
];
```

The model calls `search` with `{ query }`, `read_file` with `{ path, offset?, limit? }`, and `edit_file` with `{ path, find, replace }` — paths relative to the workspace root.

The file-access surface for a code-editing agent, and deliberately no more than that. Every path resolves through a jail that refuses anything outside the root, so the workspace should be a disposable clone — never a live checkout, never the host. `search` skips dependency and build directories and caps its hits. `read_file` is line-windowed: a large file comes back in slices with a marker saying how to read on, because sized tool results are the difference between editing a two-hundred line file and a three-thousand line one. `edit_file` requires its `find` text to appear exactly once and otherwise changes nothing, telling the model to bring more context — an agent must react to ambiguity, never have the tool guess where an edit half-fits. Reads and searches are taint-tracked (`taints: true`): workspace contents are someone's repository, not the engine's. Branching, verifying, and committing are procedures that belong to the caller, not the model.

The `workspaceTools` bundle also arms **read-before-edit** as harness discipline: a shared session records a content hash at every read, and `edit_file` refuses a file that was never read or that changed since — the agent is told to read again, never left editing a stale picture. A successful edit records the new content, so iterating on one file needs no re-read. Wire it yourself with `createWorkspaceSession()` when composing individual factories.

`diagnosticsTool({ cwd, command, args })` closes the feedback loop: the model calls it with `{}` and gets back `{ clean, output }` from a **caller-configured** check (typecheck, build, tests) — the agent chooses nothing, it can only ask the question the caller wired, which is what keeps a command-running tool inside the no-host-execution mandate. An editing agent that can see its own breakage iterates; one that cannot fails verification blind.

Each tool's Zod schema is exported beside its factory (`searchParameters`, `readFileParameters`, `editFileParameters`, `diagnosticsParameters`), so a transport serving these tools remotely — an MCP server, for instance — never restates the parameters.

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
