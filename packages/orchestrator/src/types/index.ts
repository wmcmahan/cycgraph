/**
 * Types Module — Public API
 *
 * Explicit named re-exports (NOT `export *`) so a new symbol added to any
 * leaf schema file does NOT silently enter the package's public/semver
 * surface — adding one here is a deliberate act. See the root `src/index.ts`.
 *
 * @module types
 */

// ─── Case mapping ──────────────────────────────────────────────────────
export { DEFAULT_OPAQUE_KEYS, camelKeyToSnake, camelToSnakeDeep } from './case-mapping.js';
export type { SnakeToCamel, Camelize } from './case-mapping.js';

// ─── Workflow state & actions ──────────────────────────────────────────
export {
  WorkflowStatusSchema,
  WaitingReasonSchema,
  WorkflowStateSchema,
  createWorkflowState,
  CURRENT_STATE_SCHEMA_VERSION,
  hydrateWorkflowState,
  ActionTypeSchema,
  UpdateMemoryPayloadSchema,
  LessonProvenanceEntrySchema,
  LessonProvenanceRegistrySchema,
  SetStatusPayloadSchema,
  GotoNodePayloadSchema,
  HandoffPayloadSchema,
  RequestHumanInputPayloadSchema,
  ResumeFromHumanPayloadSchema,
  MergeParallelResultsPayloadSchema,
  ActionPayloadSchemas,
  narrowActionPayload,
  InternalActionTypeSchema,
  ActionSchema,
} from './state.js';
export type {
  WorkflowStatus,
  WaitingReason,
  WorkflowState,
  WorkflowStateInput,
  WorkflowStateConfig,
  StateView,
  ActionType,
  UpdateMemoryPayload,
  SetStatusPayload,
  GotoNodePayload,
  HandoffPayload,
  RequestHumanInputPayload,
  ResumeFromHumanPayload,
  MergeParallelResultsPayload,
  TypedActionPayload,
  InternalActionType,
  Action,
  TaintMetadata,
  TaintRegistry,
  LessonProvenanceEntry,
  LessonProvenanceRegistry,
} from './state.js';

// ─── Graph structure ───────────────────────────────────────────────────
export {
  NodeTypeSchema,
  EdgeConditionSchema,
  GraphEdgeSchema,
  FailurePolicySchema,
  NodeBudgetSchema,
  SupervisorConfigSchema,
  ApprovalGateConfigSchema,
  AnnealingConfigSchema,
  MAX_MAP_ITEMS,
  MapReduceConfigSchema,
  VotingConfigSchema,
  SwarmConfigSchema,
  EvolutionConfigSchema,
  VerifierLLMJudgeConfigSchema,
  VerifierExpressionConfigSchema,
  VerifierJsonPathAssertionSchema,
  VerifierJsonPathConfigSchema,
  VerifierConfigSchema,
  VerificationResultSchema,
  ReflectionRuleBasedExtractorSchema,
  ReflectionLLMExtractorSchema,
  ReflectionConfigSchema,
  ReflectionResultSchema,
  MemoryQuerySchema,
  SubgraphConfigSchema,
  GraphNodeSchema,
  GraphSchema,
  createGraph,
} from './graph.js';
export type {
  NodeType,
  EdgeCondition,
  GraphEdge,
  FailurePolicy,
  NodeBudget,
  SupervisorConfig,
  ApprovalGateConfig,
  AnnealingConfig,
  MapReduceConfig,
  VotingConfig,
  SwarmConfig,
  EvolutionConfig,
  VerifierLLMJudgeConfig,
  VerifierExpressionConfig,
  VerifierJsonPathAssertion,
  VerifierJsonPathConfig,
  VerifierConfig,
  VerificationResult,
  ReflectionRuleBasedExtractor,
  ReflectionLLMExtractor,
  ReflectionConfig,
  ReflectionResult,
  MemoryQuery,
  SubgraphConfig,
  GraphNode,
  Graph,
  GraphInput,
  NodeConfig,
  GraphConfig,
} from './graph.js';

// ─── Event sourcing ────────────────────────────────────────────────────
export { EventTypeSchema, WorkflowEventSchema } from './event.js';
export type { EventType, WorkflowEvent, NewWorkflowEvent } from './event.js';

// ─── Tool sources & MCP transport ──────────────────────────────────────
export {
  BUILTIN_TOOL_NAMES,
  BuiltinToolSourceSchema,
  MCPToolSourceSchema,
  ToolSourceSchema,
  isStdioMcpDisabled,
  isPrivateOrLoopbackHost,
  StdioTransportSchema,
  HTTPTransportSchema,
  SSETransportSchema,
  MCPTransportConfigSchema,
  MCPServerEntrySchema,
} from './tools.js';
export type {
  ToolSource,
  ToolSourceConfig,
  BuiltinToolSource,
  MCPToolSource,
  MCPTransportConfig,
  MCPServerEntry,
  MCPServerConfig,
} from './tools.js';
