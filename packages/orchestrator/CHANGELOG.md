# @cycgraph/orchestrator

## 0.1.0-beta.2

### Patch Changes

- 2967433: Runner modularization, memory/persistence hardening, and dependency bumps.

  **@cycgraph/orchestrator**

  - Break up the monolithic `graph-runner.ts` into focused modules: `budget-monitor`, `executor-context-builder`, `fallback-tool-resolver`, `idempotency-tracker`, `memory-differ`, `persistence-coordinator`, `recover`, `router`, and `stream-channel`. Public API unchanged.
  - Add MCP `tool-circuit-breaker` and typed MCP error classes.
  - Add `runtime-config` module and expanded reducer + validation coverage.
  - Bump `@ai-sdk/anthropic` and OpenTelemetry packages.

  **@cycgraph/orchestrator-postgres**

  - Add retry helper around Drizzle persistence and event-log writes with covering tests.
  - Tighten event-log and persistence error handling.

  **@cycgraph/memory**

  - Improve `InMemoryMemoryIndex` (filtering, scoring) and adaptive memory compression with new test coverage.
