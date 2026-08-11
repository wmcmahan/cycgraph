/**
 * @cycgraph/orchestrator — Public API
 *
 * @packageDocumentation
 */

// ─── Schemas ────────────────────────────────────────────────────────

export * from './schemas.js';

// ─── Error Base Class ───────────────────────────────────────────────

export { CycgraphError } from './errors.js';

// ─── Reducers ───────────────────────────────────────────────────────

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
} from './state/reducers.js';
export type { Reducer, MemoryDropRecord } from './state/reducers.js';

// ─── Graph Runner ───────────────────────────────────────────────────

export { GraphRunner } from './execution/engine/graph-runner.js';
export type { HumanResponse, GraphRunnerEvents, GraphRunnerOptions } from './execution/engine/graph-runner.js';
export { WorkflowWorker } from './execution/coordination/worker.js';
export type { WorkflowWorkerOptions, WorkflowWorkerEvents } from './execution/coordination/worker.js';
export { createStateView } from './state/state-view.js';
export type { GraphRunnerMiddleware, MiddlewareContext, BeforeNodeResult } from './execution/middleware/middleware.js';
export type {
  SecurityPolicy,
  SecurityPolicyContext,
  SecurityPolicyDecision,
  SecurityPolicyEffect,
} from './security/security-policy.js';
export { SecurityPolicyViolationError, readableTaintedKeys } from './security/security-policy.js';
export { createObserverMiddleware } from './execution/middleware/observer-middleware.js';
export type { ObserverMiddlewareOptions, ObserverFinding, ObserverSeverity, DiagnosticAgentOptions } from './execution/middleware/observer-middleware.js';
export { BudgetExceededError, WorkflowTimeoutError, NodeConfigError, CircuitBreakerOpenError, EventLogCorruptionError, UnsupportedNodeTypeError, NodeBudgetExceededError, NoMatchingEdgeError } from './execution/errors.js';
export { MemoryWriterMissingError, VerificationFailedError, SubgraphIncompleteError, SubgraphInterfaceError } from './execution/nodes/errors.js';

// ─── Stream Events ─────────────────────────────────────────────────

export type { StreamEvent, TerminalStreamEvent, ModelResolvedEvent, ContextCompressedEvent, MemoryDiff } from './execution/streaming/stream-events.js';
export { isTerminalEvent } from './execution/streaming/stream-events.js';
export { evaluateCondition } from './execution/routing/conditions.js';
export { executeParallel } from './execution/engine/parallel-executor.js';
export type { ParallelTask, ParallelResult, ParallelExecutionConfig } from './execution/engine/parallel-executor.js';
export { executeEvolutionNode } from './execution/nodes/evolution.js';

// ─── Event Sourcing / Durable Execution ─────────────────────────────

export type { EventLogWriter } from './persistence/event-log.js';
export { NoopEventLogWriter, InMemoryEventLogWriter, EventSequenceConflictError } from './persistence/event-log.js';
export { PersistenceUnavailableError } from './persistence/persistence-health.js';

// ─── Persistence ────────────────────────────────────────────────────

export * from './persistence/index.js';

// ─── Validation ─────────────────────────────────────────────────────

export { validateGraph } from './graph/graph-validator.js';
export type { ValidationResult } from './graph/graph-validator.js';
export {
  effectiveWriteKeys,
  impliedActionPermissions,
  impliedResultKeys,
  intersectWriteGrant,
} from './security/effective-permissions.js';

// ─── Agent Runtime ──────────────────────────────────────────────────

export { agentFactory, AgentFactory, AgentNotFoundError, AgentLoadError, configureAgentFactory, configureProviderRegistry } from './agents/factory/index.js';
export { executeAgent } from './agents/executors/agent/executor.js';
export { PermissionDeniedError, AgentTimeoutError, AgentExecutionError } from './agents/executors/agent/errors.js';
export type { TokenUsage } from './agents/executors/agent/executor.js';
export { AgentConfigSchema } from './agents/types.js';
export type { AgentConfig, AgentExecutionMetadata } from './agents/types.js';

// ─── Budget-Aware Model Resolution ────────────────────────────────

export {
  ModelTierSchema,
  ModelResolutionReasonSchema,
  ESTIMATED_TOKENS_PER_CALL,
  estimateCallCost,
  defaultModelResolver,
} from './agents/models/model-resolver.js';
export type {
  ModelTier,
  ModelResolutionReason,
  ModelTierMap,
  ModelResolutionResult,
  ModelResolver,
} from './agents/models/model-resolver.js';
export { ProviderRegistry, createProviderRegistry, registerBuiltInProviders } from './agents/providers/provider-registry.js';
export type { LanguageModelFactory, ProviderOptions } from './agents/providers/provider-registry.js';
export { UnsupportedProviderError } from './agents/factory/errors.js';
export { registerOllamaProvider } from './agents/providers/ollama-provider.js';
export type { OllamaModelFactory, OllamaProviderOptions } from './agents/providers/ollama-provider.js';
export { OLLAMA_MODELS } from './agents/constants.js';

// ─── Context Compression ───────────────────────────────────────────

export type {
  ContextCompressor,
  ContextCompressionResult,
  ContextCompressionMetrics,
  ContextCompressionStageMetrics,
} from './memory/context-compressor.js';

// ─── Memory Retriever ─────────────────────────────────────────────

export type {
  MemoryRetriever,
  MemoryRetrievalResult,
} from './memory/memory-retriever.js';

// ─── Memory Writer (Reflection) ───────────────────────────────────

export type {
  MemoryWriter,
  MemoryWriterFact,
  MemoryWriterResult,
} from './memory/memory-writer.js';

// ─── Fact Sanitizer (Guardrail) ───────────────────────────────────

export type { FactSanitizer } from './security/fact-sanitizer.js';

// ─── Fitness Function (Evolution) ──────────────────────────────────

export type { FitnessFunction, FitnessResult } from './execution/nodes/fitness-function.js';

// ─── Rate Limiter (LLM call pacing) ────────────────────────────────

export type { RateLimiter, RateLimitRequest, RateLimitCallKind } from './agents/rate-limiter.js';

// ─── Evaluator (LLM-as-Judge) ───────────────────────────────────────

export { evaluateQualityExecutor as evaluateQuality } from './agents/executors/evaluator/executor.js';
export type { EvaluationResult } from './agents/executors/evaluator/executor.js';

// ─── Extractor (LLM Fact Extraction) ────────────────────────────────

export { extractFactsExecutor, DEFAULT_MAX_FACTS } from './agents/executors/extractor/executor.js';
export type { ExtractionResult as FactExtractionResult } from './agents/executors/extractor/executor.js';

// ─── Supervisor (Hierarchical Pattern) ──────────────────────────────

export { executeSupervisor, SupervisorDecisionSchema } from './agents/executors/supervisor/executor.js';
export { SUPERVISOR_DONE } from './agents/executors/supervisor/constants.js';
export { SupervisorConfigError, SupervisorRoutingError } from './agents/executors/supervisor/errors.js';
export type { SupervisorDecision } from './agents/executors/supervisor/executor.js';

export {
  agent,
  isAgentValue,
  inferProvider,
  AgentSpecError,
  node,
  isNodeValue,
  subgraph,
  graph,
  agentsForGraph,
  toolsForGraph,
  graphsForGraph,
  GraphSpecError,
  run,
  state,
  computeRequirements,
  checkRequirements,
  bundle,
  parseBundle,
  BundleIntegrityError,
} from './authoring/index.js';
export type {
  AgentSpec,
  AgentValue,
  NodeValue,
  NodeSpec,
  NodeRef,
  SubgraphSpec,
  GraphSpec,
  EdgeSugar,
  RunInput,
  RunOptions,
  GraphInputSpec,
  GraphOutputSpec,
  InterfaceSchema,
  GraphRequirements,
  RequiredTool,
  RequirementsHost,
  RequirementsCheck,
  BundleMeta,
} from './authoring/index.js';

// ─── Custom Tools ───────────────────────────────────────────────────

export { defineTool, tool, isDefinedTool, ToolDefinitionError, DEFAULT_CUSTOM_TOOL_TIMEOUT_MS } from './tools/define-tool.js';
export type { DefinedTool, DefinedToolSpec } from './tools/define-tool.js';
export { ToolNotRegisteredError, CapabilityViolationError, intersectCeilings } from './tools/registry.js';
export type { ToolsOption, CapabilityCeiling } from './tools/registry.js';

// ─── MCP Integration ────────────────────────────────────────────────

export { jsonSchemaToZod } from './mcp/json-schema-converter.js';
export type { JSONSchema } from './mcp/json-schema-converter.js';
export { MCPServerNotFoundError, MCPAccessDeniedError, ToolCircuitBreakerOpenError } from './mcp/errors.js';
export { MCPConnectionManager } from './mcp/connection-manager.js';
export type { ToolResolver } from './tools/resolver.js';
export type { TaintedToolResult as MCPTaintedToolResult, MCPConnectionManagerOptions } from './mcp/connection-manager.js';
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

export { createLogger, Logger } from './observability/logger.js';
export type { LogLevel } from './observability/logger.js';
export { initTracing, getTracer, withSpan } from './observability/tracing.js';
export { runWithContext, getCurrentContext } from './utils/context.js';
export type { RunContext } from './utils/context.js';
export {
  calculateCost,
  MODEL_PRICING,
  setModelPricing,
  loadPricingTable,
  getModelPricing,
  clearPricingOverrides,
} from './cost/pricing.js';
export type { ModelPricing } from './cost/pricing.js';
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
} from './observability/metrics.js';
export { markTainted, isTainted, getTaintRegistry, getTaintInfo, propagateDerivedTaint } from './security/taint.js';
export {
  getLessonProvenance,
  getInjectedFactIds,
  getLessonProvenanceRegistry,
} from './memory/lesson-provenance.js';
export type { LessonProvenanceEntry, LessonProvenanceRegistry } from './state/state.js';

// ─── Eval Framework ─────────────────────────────────────────────────

export * from './evals/index.js';
