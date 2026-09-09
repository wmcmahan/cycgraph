# @cycgraph/a2a

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
