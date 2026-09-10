# @cycgraph/tools

## 1.3.1

### Patch Changes

- 2f4e0b3: `pendingDiff` registers untracked files as intent-to-add before diffing, so a file an agent created shows up in the patch instead of being invisible. Reviewers and judges previously saw imports of a file that appeared not to exist and refused sound fixes.

## 1.3.0

### Minor Changes

- 47455f8: New workspace tool `create_file`: the write hand that brings a file
  into existence, so an agent driving a jailed workspace can add a
  module, a test, or a changeset instead of only modifying what already
  exists. Paths resolve through the same jail as the rest of the surface,
  parent directories are created under the root only, and contents are
  capped at 1 MiB by default. It is new-file-only — an existing path is
  refused, so `edit_file`'s read-before-edit and unique-match refusals
  cannot be routed around by overwriting. A successful create records the
  content in the shared `WorkspaceSession`, letting an agent immediately
  edit the file it just wrote, and `workspaceTools(root)` bundles it
  beside search, read, and edit. Designed by the feat-implement
  workflow's agent; landed by hand after review.
- 47455f8: PR feedback helpers for review-driven revision loops: `pushBranch` pushes a workspace branch to a branch that already has a pull request (factored out of `publishBranch`), `prFeedback` reads a PR's review bodies, conversation comments, and diff-anchored line comments (undefined when unreadable), and `commentOnPr` posts a reply.

## 1.2.0

### Minor Changes

- faf06f3: New `@cycgraph/tools/git` subpath: caller-side git delivery for
  workflows that write to a repository. Branch mechanics (`cloneToBranch`
  — which also links nested `packages/*/node_modules` trees into the
  clone, so clone-side tooling resolves non-hoisted dependencies —
  `commit` with a configurable identity, `changedIn`, `pendingDiff`,
  `publishScript`, `publishBranch` — push and open the PR, degrading to a
  pre-filled create-PR URL when `gh` is unavailable), `PublishConfig`
  resolved from the environment by `publishConfigFromEnv` (`GH_TOKEN` /
  `GITHUB_TOKEN`, `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL`), PR bodies that
  follow the target repository's `.github/PULL_REQUEST_TEMPLATE.md` via
  `prBodyFor` (prose sections filled from run evidence, checklists left
  for the human), and `deliveryNodes` — the clone/commit/publish tail of
  the maintenance pattern as wired graph nodes, batch-aware: a graph that
  cycles back through commit delivers one commit per verified fix on one
  branch, accumulating count and details, with `branchDiff` spanning the
  whole branch. `openPrFiles` lists the files open PRs under a branch
  prefix already touch, so a workflow can defer work a human owes a
  decision on, and the issue-ledger helpers (`listOpenIssues`,
  `createIssue`, `findingMarker`, `issueMarkers`) let a workflow file
  findings as deduped GitHub issues — an unreadable ledger reads as
  "cannot see", never as "none". These are procedures for the code
  driving a jailed workspace, deliberately not `defineTool` surfaces.

## 1.1.1

### Patch Changes

- 2adb2f1: edit_file's no-match refusal now diagnoses search-output poisoning: a find text carrying `NN:` line-number prefixes, or one that matches the file except for whitespace and indentation, is named as such instead of the generic "read the file and use an exact snippet".

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
