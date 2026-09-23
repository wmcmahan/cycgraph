# @cycgraph/tools

## 1.5.2

### Patch Changes

- 7081052: The workspace jail now resolves paths through `realpath` (or the deepest existing ancestor, for new files) and refuses any path whose real target leaves the root. A symlink planted inside a workspace — such as a linked `node_modules` — can no longer be used by `read_file`, `edit_file`, or `create_file` to read or write outside the sandbox.
- f29ecf9: `web_fetch` and `http_request` now re-check `allowedHosts` on every redirect hop and drop operator `defaultHeaders` (plus `authorization`, `cookie`, and `proxy-authorization`) once a hop changes origin, so an allowed host can no longer 302 configured credentials to another host. Requests that redirect off the allowlist fail with `HostNotAllowedError` instead of being followed.

## 1.5.1

### Patch Changes

- 3f833a4: `linkNestedModules` now links every internal workspace package at the group level of the clone (`packages/node_modules/@scope/name` → the clone's own package), ahead of the root symlink to the source repository's dependency tree on Node's resolution walk. Before this, a consumer package's build inside a clone type-checked against the source checkout's stale dist, so a cross-package edit could never pass the clone's own checks — an unwinnable gate for any fix that adds to a dependency's exported types. Manifest names are validated against npm's name grammar before becoming link paths, and a directory the nested-link pass symlinked to the checkout is replaced by a real clone-local directory before anything is written beneath it, so clone contents can neither steer nor forward a write outside the clone.

## 1.5.0

### Minor Changes

- ac38f50: Additions to the git surface: `commentOnIssue` and `addIssueLabel` (the label is created on the repository when missing), used by workflows that flag an issue as waiting on a human; `viewIssue`, one issue's title and body by number, for briefing a reviewer on the intent a PR claims to serve; and `prFeedback` now carries the PR `body`, so a review can read the description and its `Closes #N` linkage instead of only the title. `diagnosticsTool` output past the line cap now surfaces failure-marker lines (`FAIL`, `npm error`, `Error:` and its subclasses) ahead of the tail under a count header, so a multi-workspace test run cannot bury its failing suite under a later workspace's passing output; header and separator count against the cap. Each reported line is also capped at `maxLineLength` characters (default 400) with a truncation marker, because a line cap alone bounds nothing when structured-log emitters put kilobytes on a single line.

### Patch Changes

- 7301997: `searchTool` caps each reported matching line at `maxLineLength` characters (default 400) with a truncation marker. A match inside a single-line data blob previously put megabytes into one tool result, oversizing every later request of the agent's turn. The substring match still runs on the full line; the cap applies only to what is reported.

## 1.4.2

### Patch Changes

- e70416c: Agent Card endpoint URLs are now re-checked at connect time: each endpoint host is resolved and refused when any address is private/loopback/link-local, so a public-looking name backed by a private DNS record no longer reaches internal services, and a lookup that fails or times out fails closed. The resolve-and-reject policy is shared with the MCP transport and web-tool guards, which changes two user-visible details: blocked web fetches now report `resolves to a private/loopback address (<addresses>)` and list every offending address, and the MCP guard logs lookup failures as `mcp_ssrf_lookup_failed` while `mcp_ssrf_blocked_resolved_ip` keeps its `blocked` addresses field.
- 68853cb: `commit` now pins the commit identity through `GIT_AUTHOR_*`/`GIT_COMMITTER_*` env as well as `-c user.*`: ambient git identity variables (as CI sets for the workflow's own commits) override `-c`, which made commits land under the environment's identity instead of the configured one.
- 68853cb: `diagnosticsTool` now keeps the LAST lines of a failing check's output past the line cap instead of the first: test runners and linters print their failure detail and summary at the end, so head-keeping handed consumers pages of passing output with the actual reason truncated away. The truncation banner also changed: `[N earlier line(s) truncated]` at the START of the output replaces `[N more line(s) truncated]` at the end.

## 1.4.1

### Patch Changes

- e004a48: `diagnosticsTool` accepts an `env` option so callers can hand the spawned check a scrubbed environment instead of the full process env.

## 1.4.0

### Minor Changes

- 2a15a85: `prFeedback` now reports the PR's label names and stamps every relayed comment with the author's repository association, so consumers that treat comment text as instructions can gate on it — commenting needs no permission, making association the only trust signal a comment carries. `PublishConfig` accepts `labels` to apply to a pull request on creation (best-effort — a label the repository lacks is skipped, never a failed publish).

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
