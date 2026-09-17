# @cycgraph/a2a

## 1.1.6

### Patch Changes

- f015535: The Agent Card URL is now DNS re-checked at connect time before the card request leaves, matching the MCP transport and web-fetch guards: a registry entry whose host resolved publicly when it was written but privately when it is called (DNS rebinding) no longer reaches loopback, internal, or cloud-metadata addresses. Lookup failure fails closed, and `CYCGRAPH_ALLOW_PRIVATE_A2A_URLS=true` still skips both A2A guards for local development.

## 1.1.5

### Patch Changes

- e70416c: Agent Card endpoint URLs are now re-checked at connect time: each endpoint host is resolved and refused when any address is private/loopback/link-local, so a public-looking name backed by a private DNS record no longer reaches internal services, and a lookup that fails or times out fails closed. The resolve-and-reject policy is shared with the MCP transport and web-tool guards, which changes two user-visible details: blocked web fetches now report `resolves to a private/loopback address (<addresses>)` and list every offending address, and the MCP guard logs lookup failures as `mcp_ssrf_lookup_failed` while `mcp_ssrf_blocked_resolved_ip` keeps its `blocked` addresses field.

## 1.1.4

### Patch Changes

- 85bd517: Bound each shared Agent Card resolution with its own 30s timeout and evict the cache entry when it fires. A remote that accepted the connection and never answered previously left a permanently pending card promise cached for that agent, failing every later call to it until the process restarted.

## 1.1.3

### Patch Changes

- 303944f: The Agent Card cache is now keyed by agent card URL plus the headers the card was fetched with, so two registry entries that share one `agent_card_url` but use different credentials each resolve the card with their own auth instead of silently reusing the first caller's cached card.
- c31a48d: The endpoints a resolved Agent Card offers are now SSRF-guarded before any transport is built: the registry validates the card URL, but the card's returned RPC endpoints come from the remote, and a compromised agent could point the transport at loopback or cloud-metadata hosts. Honors the same `CYCGRAPH_ALLOW_PRIVATE_A2A_URLS=true` development opt-out as the card-url guard.

## 1.1.2

### Patch Changes

- e2b590b: Translate a bare `Message` reply from `message/send` into a completed task result whose `response` artifact carries the reply's parts. Agents that answer statelessly without creating a task no longer fail every `a2a` node with a fabricated failure that discarded the reply.
- a385ce1: A multi-part `status.message` is no longer dropped: every part now contributes to `A2ATaskResult.message`, joined by newline in wire order, so an `input-required` pause still shows the remote agent's question when it arrives as more than one part.

## 1.1.1

### Patch Changes

- 7c79357: Agent Card resolution now carries the same per-server auth headers as every other request, so registries that gate their card endpoint behind the entry's credential resolve instead of failing with a generic transport error. A failed card resolution is also evicted from the per-URL cache, so a transient fault at boot no longer poisons that server for the life of the client.

## 1.1.0

### Minor Changes

- 9671a03: `timeoutMs` and `abortSignal` now bound the whole delivery — client construction, the blocking `message/send`, and every settle poll — with the signal threaded into the SDK transport's fetch. A remote that accepts the connection and stalls no longer hangs the node forever: a bound that fires mid-settle still returns the last observed task, and one that fires before any task exists throws a clear timeout or caller-abort error. `CreateSdkClient` gains an optional `signal` parameter (backward compatible).

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

## 0.1.0

### Minor Changes

- 37d6451: Agent2Agent (A2A) interop: delegate a graph step to a remote agent.

  New `a2a` node type, sibling to `subgraph`: same mapping convention and
  implied write grants, but budget and capability ceilings deliberately stop
  at the network boundary and everything returned is taint-tracked. A remote
  `input-required` pauses the run through the existing HITL machinery and
  resumes the same remote task, including when nested inside a subgraph.
  `rejected` and `auth-required` tasks are classified non-retryable.

  Supporting pieces: a trusted `A2AServerRegistry` (SSRF-guarded Agent Card
  URLs, credentials as named env vars, per-server `propagateTraceContext`),
  an `A2AClient` port so core carries no protocol dependency, `toAgentCard` /
  `agentCardFidelity` for publishing a graph's interface, and the new
  `@cycgraph/a2a` package implementing the port on `@a2a-js/sdk`.
