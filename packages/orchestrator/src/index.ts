/**
 * @cycgraph/orchestrator — Public API
 *
 * This is the package entry point. All public types, classes, and
 * functions are re-exported here. Consumers should import from
 * `@cycgraph/orchestrator` and never reach into internal paths.
 *
 * Implementation details that are not part of the semver contract (the runner's
 * internal reducer, the stream channel, filtrex/backoff internals) live behind
 * the `@cycgraph/orchestrator/internal` subpath — see `src/internal.ts`.
 *
 * @packageDocumentation
 */

// ─── Core Types ─────────────────────────────────────────────────────
// State, Graph, Event schemas and TypeScript types

export * from './types/index.js';

// ─── Reducers ───────────────────────────────────────────────────────
// Pure state transition functions. Explicit named exports — `internalReducer`
// is intentionally NOT public (it's exposed via `@cycgraph/orchestrator/internal`).

export {
  REPLAY_VERSION,
  MAX_SUPERVISOR_HISTORY,
  MAX_VISITED_NODES,
  MAX_MEMORY_DROPS,
  updateMemoryReducer,
  setStatusReducer,
  gotoNodeReducer,
  handoffReducer,
  requestHumanInputReducer,
  resumeFromHumanReducer,
  mergeParallelResultsReducer,
  rootReducer,
  validateAction,
  canTransitionStatus,
  isTerminalStatus,
  TERMINAL_STATUSES,
} from './reducers/index.js';
export type { Reducer, MemoryDropRecord } from './reducers/index.js';

// ─── Graph Runner ───────────────────────────────────────────────────
// Workflow execution engine

export { GraphRunner } from './runner/graph-runner.js';
export type { HumanResponse, GraphRunnerEvents, GraphRunnerOptions } from './runner/graph-runner.js';
export { WorkflowWorker } from './runner/worker.js';
export type { WorkflowWorkerOptions, WorkflowWorkerEvents } from './runner/worker.js';
export { createStateView } from './runner/state-view.js';
export type { GraphRunnerMiddleware, MiddlewareContext, BeforeNodeResult } from './runner/middleware.js';
export { createObserverMiddleware } from './runner/observer-middleware.js';
export type { ObserverMiddlewareOptions, ObserverFinding, ObserverSeverity, DiagnosticAgentOptions } from './runner/observer-middleware.js';
export { BudgetExceededError, WorkflowTimeoutError, NodeConfigError, CircuitBreakerOpenError, EventLogCorruptionError, UnsupportedNodeTypeError, NodeBudgetExceededError, NoMatchingEdgeError } from './runner/errors.js';
export { MemoryWriterMissingError } from './runner/node-executors/reflection.js';
export { VerificationFailedError } from './runner/node-executors/verifier.js';

// ─── Stream Events ─────────────────────────────────────────────────
export type { StreamEvent, TerminalStreamEvent, ModelResolvedEvent, ContextCompressedEvent, MemoryDiff } from './runner/stream-events.js';
export { isTerminalEvent } from './runner/stream-events.js';
// `StreamChannel` and the low-level `helpers`/filtrex `conditions` internals are
// NOT public — see `@cycgraph/orchestrator/internal`. Only the public condition
// evaluator is re-exported here.
export { evaluateCondition } from './runner/conditions.js';
export { executeParallel } from './runner/parallel-executor.js';
export type { ParallelTask, ParallelResult, ParallelExecutionConfig } from './runner/parallel-executor.js';
export { executeEvolutionNode } from './runner/node-executors/evolution.js';

// ─── Event Sourcing / Durable Execution ─────────────────────────────

export type { EventLogWriter } from './db/event-log.js';
export { NoopEventLogWriter, InMemoryEventLogWriter, EventSequenceConflictError } from './db/event-log.js';
export { PersistenceUnavailableError } from './db/persistence-health.js';

// ─── Persistence ────────────────────────────────────────────────────
// Interfaces and in-memory implementations

export * from './persistence/index.js';

// ─── Validation ─────────────────────────────────────────────────────

export * from './validation/graph-validator.js';

// ─── Agent Runtime ──────────────────────────────────────────────────

export { agentFactory, AgentFactory, AgentNotFoundError, AgentLoadError, configureAgentFactory, configureProviderRegistry } from './agent/agent-factory/index.js';
export { executeAgent } from './agent/agent-executor/executor.js';
export { PermissionDeniedError, AgentTimeoutError, AgentExecutionError } from './agent/agent-executor/errors.js';
export type { TokenUsage } from './agent/agent-executor/executor.js';
export { AgentConfigSchema } from './agent/types.js';
export type { AgentConfig, AgentExecutionMetadata } from './agent/types.js';

// ─── Budget-Aware Model Resolution ────────────────────────────────
export {
  ModelTierSchema,
  ModelResolutionReasonSchema,
  ESTIMATED_TOKENS_PER_CALL,
  estimateCallCost,
  defaultModelResolver,
} from './agent/model-resolver.js';
export type {
  ModelTier,
  ModelResolutionReason,
  ModelTierMap,
  ModelResolutionResult,
  ModelResolver,
} from './agent/model-resolver.js';
export { ProviderRegistry, createProviderRegistry, registerBuiltInProviders } from './agent/provider-registry.js';
export type { LanguageModelFactory, ProviderOptions } from './agent/provider-registry.js';
export { UnsupportedProviderError } from './agent/agent-factory/errors.js';
export { registerOllamaProvider } from './agent/ollama-provider.js';
export type { OllamaModelFactory, OllamaProviderOptions } from './agent/ollama-provider.js';
export { OLLAMA_MODELS } from './agent/constants.js';

// ─── Context Compression ───────────────────────────────────────────
export type {
  ContextCompressor,
  ContextCompressionResult,
  ContextCompressionMetrics,
  ContextCompressionStageMetrics,
} from './agent/context-compressor.js';

// ─── Memory Retriever ─────────────────────────────────────────────
export type {
  MemoryRetriever,
  MemoryRetrievalResult,
} from './agent/memory-retriever.js';

// ─── Memory Writer (Reflection) ───────────────────────────────────
export type {
  MemoryWriter,
  MemoryWriterFact,
  MemoryWriterResult,
} from './agent/memory-writer.js';

// ─── Fact Sanitizer (Guardrail) ───────────────────────────────────
export type { FactSanitizer } from './agent/fact-sanitizer.js';

// ─── Fitness Function (Evolution) ──────────────────────────────────
export type { FitnessFunction, FitnessResult } from './agent/fitness-function.js';

// ─── Rate Limiter (LLM call pacing) ────────────────────────────────
export type { RateLimiter, RateLimitRequest, RateLimitCallKind } from './agent/rate-limiter.js';

// ─── Evaluator (LLM-as-Judge) ───────────────────────────────────────

export { evaluateQualityExecutor as evaluateQuality } from './agent/evaluator-executor/executor.js';
export type { EvaluationResult } from './agent/evaluator-executor/executor.js';

// ─── Extractor (LLM Fact Extraction) ────────────────────────────────

export { extractFactsExecutor, DEFAULT_MAX_FACTS } from './agent/extractor-executor/executor.js';
export type { ExtractionResult as FactExtractionResult } from './agent/extractor-executor/executor.js';

// ─── Supervisor (Hierarchical Pattern) ──────────────────────────────

export { executeSupervisor, SupervisorDecisionSchema } from './agent/supervisor-executor/executor.js';
export { SUPERVISOR_DONE } from './agent/supervisor-executor/constants.js';
export { SupervisorConfigError, SupervisorRoutingError } from './agent/supervisor-executor/errors.js';
export type { SupervisorDecision } from './agent/supervisor-executor/executor.js';

// ─── MCP Integration ────────────────────────────────────────────────

export { jsonSchemaToZod } from './mcp/json-schema-converter.js';
export type { JSONSchema } from './mcp/json-schema-converter.js';
export { MCPServerNotFoundError, MCPAccessDeniedError, ToolCircuitBreakerOpenError } from './mcp/errors.js';
export { MCPConnectionManager } from './mcp/connection-manager.js';
export type { ToolResolver, TaintedToolResult as MCPTaintedToolResult, MCPConnectionManagerOptions } from './mcp/connection-manager.js';
export { ToolCircuitBreakerManager } from './mcp/tool-circuit-breaker.js';
export type {
  ToolCircuitBreakerOptions,
  ToolCircuitBreakerStatus,
  ToolCircuitBreakerState,
  ToolCircuitBreakerMetrics,
} from './mcp/tool-circuit-breaker.js';
export {
  registerDefaultMCPServers,
  DEFAULT_MCP_SERVERS,
  WEB_SEARCH_SERVER,
  FETCH_SERVER,
} from './mcp/default-servers.js';
export type { RegisterDefaultMCPServersOptions } from './mcp/default-servers.js';

// ─── Workflow Architect ─────────────────────────────────────────────

export { generateWorkflow } from './architect/index.js';
export { LLMGraphSchema } from './architect/schemas.js';
export { ArchitectError } from './architect/errors.js';
export type { GenerateWorkflowOptions, GenerateWorkflowResult, LLMGraph } from './architect/index.js';
export { initArchitectTools, architectToolDefinitions, executeArchitectTool } from './architect/tools.js';
export type { ArchitectToolDeps } from './architect/tools.js';

// ─── Utilities ──────────────────────────────────────────────────────

export { createLogger, Logger } from './utils/logger.js';
export type { LogLevel } from './utils/logger.js';
export { initTracing, getTracer, withSpan } from './utils/tracing.js';
export { runWithContext, getCurrentContext } from './utils/context.js';
export type { RunContext } from './utils/context.js';
export { calculateCost, MODEL_PRICING } from './utils/pricing.js';
export type { ModelPricing } from './utils/pricing.js';
export {
  initMetrics,
  collectMetrics,
  incrementWorkflowsStarted,
  incrementWorkflowsCompleted,
  incrementWorkflowsFailed,
  recordWorkflowDuration,
  recordTokensUsed,
  recordCostUsd,
  recordAgentDuration,
  setQueueDepthProvider,
} from './utils/metrics.js';
export { markTainted, isTainted, getTaintRegistry, getTaintInfo, propagateDerivedTaint } from './utils/taint.js';
export {
  getLessonProvenance,
  getInjectedFactIds,
  getLessonProvenanceRegistry,
} from './utils/lesson-provenance.js';
export type { LessonProvenanceEntry, LessonProvenanceRegistry } from './types/state.js';

// ─── Eval Framework ─────────────────────────────────────────────────

export * from './evals/index.js';
