/**
 * Workflow State Types
 *
 * Core state machine types for workflow execution. Defines the complete
 * workflow status lifecycle, working memory, token/cost tracking,
 * compensation (saga) pattern, and the Action schema used by reducers.
 *
 * @module types/state
 */

import { z } from 'zod';
import { type Camelize, camelToSnakeDeep } from './case-mapping.js';

// ─── Status & Waiting ───────────────────────────────────────────────

/**
 * Complete workflow status state machine.
 *
 * Follows industry standards from Temporal, Airflow, etc.
 *
 * ```
 * pending → scheduled → running → completed
 *                     ↓        ↗ ↓
 *                   waiting   retrying → failed
 *                                      ↓
 *                                   cancelled / timeout
 * ```
 */
export const WorkflowStatusSchema = z.enum([
  // Initial states
  'pending',        // Created but not started
  'scheduled',      // Waiting for scheduled start time

  // Active states
  'running',        // Currently executing
  'waiting',        // Paused for human-in-the-loop or external event
  'retrying',       // Failed step, attempting retry

  // Terminal states (cannot transition out)
  'completed',      // Successfully finished
  'failed',         // Unrecoverable error
  'cancelled',      // User/system cancelled
  'timeout',        // Exceeded max execution time
]);

export type WorkflowStatus = z.infer<typeof WorkflowStatusSchema>;

/**
 * Reasons a workflow may be in the `waiting` status.
 */
export const WaitingReasonSchema = z.enum([
  'human_approval',  // Human-in-the-loop review
  'external_event',  // Waiting for webhook/callback
  'scheduled_time',  // Cron/scheduled execution
  'rate_limit',      // API rate limiting
  'resource_limit',  // System resource constraints
]);

export type WaitingReason = z.infer<typeof WaitingReasonSchema>;

// ─── Workflow State ─────────────────────────────────────────────────

/**
 * Complete workflow state.
 *
 * This is the single source of truth for a running workflow. It is
 * persisted after every reducer dispatch and used for crash recovery.
 */
export const WorkflowStateSchema = z.object({
  // ── Schema versioning ──
  /**
   * Version of this state shape. Bumped when WorkflowState evolves in a way
   * that requires migration of persisted snapshots/checkpoints. Loaded states
   * pass through {@link hydrateWorkflowState}, which migrates older versions
   * forward before parsing.
   */
  state_schema_version: z.number().int().positive().default(1),

  // ── Core metadata ──
  /** Graph definition ID. */
  workflow_id: z.string().uuid(),
  /** Unique run identifier (auto-generated if omitted). */
  run_id: z.string().uuid().default(() => crypto.randomUUID()),
  /** When this run was created (defaults to now). */
  created_at: z.coerce.date().default(() => new Date()),
  /** Last state mutation timestamp (defaults to now). */
  updated_at: z.coerce.date().default(() => new Date()),

  // ── User input ──
  /** High-level objective for this workflow run. */
  goal: z.string(),
  /** Optional constraints the workflow must respect. */
  constraints: z.array(z.string()).default([]),

  // ── Control flow ──
  /**
   * Event-log high-water mark at the moment this snapshot was persisted —
   * the highest sequence_id whose event was flushed before the snapshot
   * committed. Runner-internal bookkeeping: lets resume logic decide
   * whether an `action_dispatched` event's effects are already contained
   * in this snapshot (sequence_id <= mark) or still pending re-execution.
   */
  _last_event_sequence_id: z.number().int().optional(),
  /** Current lifecycle status (defaults to 'pending'). */
  status: WorkflowStatusSchema.default('pending'),
  /** Node currently being executed. */
  current_node: z.string().optional(),
  /** Number of reducer dispatches (loop guard). */
  iteration_count: z.number().default(0),

  // ── Retry management ──
  /** Number of retries on the current node. */
  retry_count: z.number().default(0),
  /** Maximum retries before the node fails. */
  max_retries: z.number().default(3),
  /** Error message from the most recent failure. */
  last_error: z.string().optional(),

  // ── Waiting state ──
  /** Why the workflow is paused (set when status is `waiting`). */
  waiting_for: WaitingReasonSchema.optional(),
  /** When the workflow entered the `waiting` state. */
  waiting_since: z.coerce.date().optional(),
  /** Deadline after which the wait times out. */
  waiting_timeout_at: z.coerce.date().optional(),

  // ── Execution timeouts ──
  /** When `run()` was first invoked. */
  started_at: z.coerce.date().optional(),
  /** Wall-clock timeout for the entire run (default: 1 hour). */
  max_execution_time_ms: z.number().default(3_600_000),

  // ── Working memory ──
  /** Dynamic key-value store shared between nodes. */
  memory: z.record(z.string(), z.unknown()).default({}),

  // ── Token budget ──
  /** Cumulative tokens consumed across all LLM calls. */
  total_tokens_used: z.number().default(0),
  /** Cumulative prompt/input tokens (the input half of {@link total_tokens_used}). */
  total_input_tokens: z.number().default(0),
  /** Cumulative completion/output tokens (the output half of {@link total_tokens_used}). */
  total_output_tokens: z.number().default(0),
  /** If set, workflow fails when token usage exceeds this limit. */
  max_token_budget: z.number().optional(),

  // ── Cost tracking (USD) ──
  /** Cumulative estimated cost in USD. */
  total_cost_usd: z.number().default(0),
  /** Per-run cost budget (fail when exceeded). */
  budget_usd: z.number().optional(),
  /** Threshold percentages already fired (prevents duplicate alerts). */
  _cost_alert_thresholds_fired: z.array(z.number()).default([]),

  // ── Per-model usage breakdown ──
  /**
   * Cumulative token/cost usage attributed per model id, populated on every
   * LLM call so billing can break spend down by model. Token counts are the
   * provider's reported usage; `cost_usd` is an estimate (tokens ×
   * {@link MODEL_PRICING}, see {@link total_cost_usd}). `calls` counts the
   * number of LLM invocations attributed to the model.
   */
  model_breakdown: z.record(z.string(), z.object({
    input_tokens: z.number().default(0),
    output_tokens: z.number().default(0),
    cost_usd: z.number().default(0),
    calls: z.number().default(0),
  })).default({}),

  // ── Execution tracking ──
  /** Node IDs visited in execution order. */
  visited_nodes: z.array(z.string()).default([]),
  /** Maximum iterations before the run is forcefully terminated. */
  max_iterations: z.number().default(50),

  // ── Compensation (saga pattern) ──
  /** Stack of compensating actions for rollback on failure. */
  compensation_stack: z.array(z.object({
    action_id: z.string(),
    compensation_action: z.object({
      type: z.string(),
      payload: z.record(z.string(), z.unknown()),
    }),
  })).default([]),

  // ── Supervisor history ──
  /** Routing decisions made by supervisor nodes (for debugging). */
  supervisor_history: z.array(z.object({
    supervisor_id: z.string(),
    delegated_to: z.string(),
    reasoning: z.string(),
    iteration: z.number(),
    timestamp: z.coerce.date(),
  })).default([]),

  // ── Memory drop audit log ──
  /**
   * Ring buffer of memory updates that were rejected by reducers
   * (oversized JSON or non-serializable). Bounded to the most recent
   * entries; see `MAX_MEMORY_DROPS` in `reducers/index.ts`. The GraphRunner
   * emits a `memory:dropped` stream event for each new entry — this field
   * is the durable, queryable trail after the run completes.
   */
  memory_drops: z.array(z.object({
    key: z.string(),
    reason: z.enum(['oversized', 'non_serializable']),
    bytes: z.number().optional(),
    node_id: z.string().optional(),
    timestamp: z.coerce.date(),
  })).default([]),
});

export type WorkflowState = z.infer<typeof WorkflowStateSchema>;

/** Wire-format input type (snake_case) — only `workflow_id` and `goal` are required. */
export type WorkflowStateInput = z.input<typeof WorkflowStateSchema>;

/**
 * camelCase authoring type for `createWorkflowState()`, derived from the
 * snake_case wire schema. Only `workflowId` and `goal` are required.
 */
export type WorkflowStateConfig = Camelize<WorkflowStateInput>;

/**
 * Create a valid WorkflowState from idiomatic camelCase authoring input.
 *
 * Only `workflowId` and `goal` are required. All runtime-managed fields
 * (`runId`, `createdAt`, `status`, `iterationCount`, etc.) are auto-populated
 * via schema defaults. The freeform `memory` blackboard keeps arbitrary keys.
 *
 * The returned object is the snake_case runtime {@link WorkflowState} (the
 * engine and database format). To build state from a snake_case wire object
 * (e.g. loaded from persistence), use `WorkflowStateSchema.parse` /
 * `hydrateWorkflowState` directly. The runtime remap is idempotent on
 * snake_case keys, so wire objects are tolerated here too.
 *
 * @example
 * ```typescript
 * const state = createWorkflowState({
 *   workflowId: graph.id,
 *   goal: 'Research and summarize quantum computing',
 *   constraints: ['Under 500 words'],
 *   maxExecutionTimeMs: 120_000,
 * });
 * ```
 */
export function createWorkflowState(input: WorkflowStateConfig): WorkflowState {
  return WorkflowStateSchema.parse(camelToSnakeDeep(input));
}

// ─── State Hydration (load-boundary parsing + migration) ───────────

/** Current WorkflowState schema version. Bump together with a migration entry. */
export const CURRENT_STATE_SCHEMA_VERSION = 1;

/**
 * Ordered migrations applied to raw persisted state before parsing.
 *
 * Each entry upgrades a state from `from` to `from + 1`. When the schema
 * evolves, bump {@link CURRENT_STATE_SCHEMA_VERSION} and append a migration
 * here — `hydrateWorkflowState` chains them so any historical snapshot loads.
 */
const STATE_MIGRATIONS: Record<number, (raw: Record<string, unknown>) => Record<string, unknown>> = {
  // Example shape for a future v1 → v2 migration:
  // 1: (raw) => ({ ...raw, new_required_field: defaultValue, state_schema_version: 2 }),
};

/**
 * Hydrate a persisted WorkflowState at a load boundary.
 *
 * Persisted snapshots round-trip through JSON/jsonb, which turns every `Date`
 * into a string — comparing `new Date() >= waiting_timeout_at` against a
 * string silently never fires, and `.toISOString()` crashes. Every code path
 * that loads state from storage (checkpoints, snapshots, recovery) MUST pass
 * it through this function, which:
 *
 * 1. Runs any pending schema migrations (versions older than
 *    {@link CURRENT_STATE_SCHEMA_VERSION}).
 * 2. Parses with {@link WorkflowStateSchema}, coercing temporal fields back
 *    to `Date` and failing loudly on structurally invalid state.
 *
 * @throws {z.ZodError} If the state is invalid after migration — a corrupt
 *   snapshot must never silently enter the execution loop.
 */
export function hydrateWorkflowState(raw: unknown): WorkflowState {
  if (raw === null || typeof raw !== 'object') {
    throw new Error('Cannot hydrate workflow state: value is not an object');
  }

  let candidate = raw as Record<string, unknown>;
  // States persisted before versioning carry no marker — treat as v1.
  let version = typeof candidate.state_schema_version === 'number'
    ? candidate.state_schema_version
    : 1;

  while (version < CURRENT_STATE_SCHEMA_VERSION) {
    const migrate = STATE_MIGRATIONS[version];
    if (!migrate) {
      throw new Error(
        `Cannot hydrate workflow state: no migration registered for schema version ${version} ` +
        `(current: ${CURRENT_STATE_SCHEMA_VERSION})`,
      );
    }
    candidate = migrate(candidate);
    version++;
  }

  if (version > CURRENT_STATE_SCHEMA_VERSION) {
    throw new Error(
      `Cannot hydrate workflow state: snapshot schema version ${version} is newer than ` +
      `this engine's ${CURRENT_STATE_SCHEMA_VERSION}. Upgrade the engine before resuming this run.`,
    );
  }

  return WorkflowStateSchema.parse({ ...candidate, state_schema_version: version });
}

// ─── State View ─────────────────────────────────────────────────────

/**
 * Read-only view of workflow state exposed to agents.
 *
 * Acts as a security boundary — the `memory` field only contains keys
 * from the agent's `read_keys` permission list.
 */
export interface StateView {
  /** Graph definition ID. */
  workflow_id: string;
  /** Unique run identifier. */
  run_id: string;
  /** High-level objective. */
  goal: string;
  /** Constraints the workflow must respect. */
  constraints: string[];
  /** Filtered memory (only keys in the agent's `read_keys`). */
  memory: Record<string, unknown>;
}

// ─── Action Schema ──────────────────────────────────────────────────

/**
 * Discriminated union of known public action types.
 *
 * Internal action types (prefixed with `_` like `_init`, `_fail`, `_complete`)
 * are dispatched through `dispatchInternal()` in GraphRunner and bypass
 * `ActionSchema` validation entirely — they are NOT included here.
 */
export const ActionTypeSchema = z.enum([
  'update_memory',
  'set_status',
  'goto_node',
  'handoff',
  'request_human_input',
  'resume_from_human',
  'merge_parallel_results',
]);

export type ActionType = z.infer<typeof ActionTypeSchema>;

// ─── Per-Action Payload Schemas ─────────────────────────────────────

export const UpdateMemoryPayloadSchema = z.object({
  updates: z.record(z.string(), z.unknown()),
});
export type UpdateMemoryPayload = z.infer<typeof UpdateMemoryPayloadSchema>;

/**
 * One lesson-provenance entry on an action payload: the facts injected
 * into a node's prompt via its `memory_query`. Mirrors the
 * {@link LessonProvenanceEntry} interface below; defined here as a Zod
 * schema so payload `.parse()` validates (and does not strip) it.
 */
export const LessonProvenanceEntrySchema = z.object({
  node_id: z.string(),
  agent_id: z.string().optional(),
  fact_ids: z.array(z.string()),
  retrieved_at: z.string(),
});
/** Registry of provenance entries keyed by per-entry UUID. */
export const LessonProvenanceRegistrySchema = z.record(z.string(), LessonProvenanceEntrySchema);

export const SetStatusPayloadSchema = z.object({
  status: WorkflowStatusSchema,
  /**
   * Lesson provenance minted when a supervisor's `set_status` (completion)
   * action was produced — facts injected into the routing prompt. Merged
   * append-only into `memory._lesson_provenance` by `setStatusReducer` so
   * supervisor retrieval is attributable to run outcomes, same as agent nodes.
   */
  lesson_provenance: LessonProvenanceRegistrySchema.optional(),
});
export type SetStatusPayload = z.infer<typeof SetStatusPayloadSchema>;

export const GotoNodePayloadSchema = z.object({
  node_id: z.string(),
});
export type GotoNodePayload = z.infer<typeof GotoNodePayloadSchema>;

export const HandoffPayloadSchema = z.object({
  node_id: z.string(),
  supervisor_id: z.string(),
  reasoning: z.string(),
  /**
   * Lesson provenance minted when this handoff was produced — facts
   * injected into the supervisor's routing prompt. Merged append-only into
   * `memory._lesson_provenance` by `handoffReducer` so supervisor retrieval
   * is attributable to run outcomes, same as agent nodes.
   */
  lesson_provenance: LessonProvenanceRegistrySchema.optional(),
});
export type HandoffPayload = z.infer<typeof HandoffPayloadSchema>;

export const RequestHumanInputPayloadSchema = z.object({
  waiting_for: WaitingReasonSchema.optional(),
  timeout_ms: z.number().optional(),
  /** Arbitrary review payload. Optional — agents pausing for generic input may omit it. */
  pending_approval: z.unknown().optional(),
  /**
   * Extra memory to persist as part of the pause. Used by the subgraph executor
   * to stash a child-run checkpoint alongside the parent's `waiting` transition,
   * so resume can rehydrate and continue the child. Applied before
   * `_pending_approval` so it can't clobber it.
   */
  memory_updates: z.record(z.string(), z.unknown()).optional(),
});
export type RequestHumanInputPayload = z.infer<typeof RequestHumanInputPayloadSchema>;

export const ResumeFromHumanPayloadSchema = z.object({
  response: z.unknown(),
  decision: z.unknown(),
  memory_updates: z.record(z.string(), z.unknown()).optional(),
});
export type ResumeFromHumanPayload = z.infer<typeof ResumeFromHumanPayloadSchema>;

export const MergeParallelResultsPayloadSchema = z.object({
  updates: z.record(z.string(), z.unknown()),
  total_tokens: z.number().optional(),
});
export type MergeParallelResultsPayload = z.infer<typeof MergeParallelResultsPayloadSchema>;

/**
 * Map from action type to its payload schema.
 * Used by {@link narrowActionPayload} for runtime validation.
 */
export const ActionPayloadSchemas = {
  update_memory: UpdateMemoryPayloadSchema,
  set_status: SetStatusPayloadSchema,
  goto_node: GotoNodePayloadSchema,
  handoff: HandoffPayloadSchema,
  request_human_input: RequestHumanInputPayloadSchema,
  resume_from_human: ResumeFromHumanPayloadSchema,
  merge_parallel_results: MergeParallelResultsPayloadSchema,
} as const satisfies Record<ActionType, z.ZodType>;

/**
 * Discriminated union of typed action payloads.
 * Use with {@link narrowActionPayload} for type-safe payload access.
 */
export type TypedActionPayload =
  | { type: 'update_memory'; payload: UpdateMemoryPayload }
  | { type: 'set_status'; payload: SetStatusPayload }
  | { type: 'goto_node'; payload: GotoNodePayload }
  | { type: 'handoff'; payload: HandoffPayload }
  | { type: 'request_human_input'; payload: RequestHumanInputPayload }
  | { type: 'resume_from_human'; payload: ResumeFromHumanPayload }
  | { type: 'merge_parallel_results'; payload: MergeParallelResultsPayload };

/**
 * Narrow an action's payload to the typed schema for its action type.
 * Returns the parsed payload or throws a `ZodError` on mismatch.
 *
 * Usage: `const { updates } = narrowActionPayload('update_memory', action.payload);`
 */
export function narrowActionPayload(
  type: ActionType,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return ActionPayloadSchemas[type].parse(payload) as Record<string, unknown>;
}

// ─── Internal Action Types ──────────────────────────────────────────

/**
 * Enum of `_`-prefixed internal action types dispatched by the GraphRunner.
 * These bypass `ActionSchema` validation and are handled by `internalReducer`.
 */
export const InternalActionTypeSchema = z.enum([
  '_init',
  '_fail',
  '_complete',
  '_advance',
  '_timeout',
  '_cancel',
  '_track_tokens',
  '_track_cost',
  '_track_model_usage',
  '_fire_cost_threshold',
  '_budget_exceeded',
  '_push_compensation',
  '_increment_iteration',
  '_pop_compensation',
]);

export type InternalActionType = z.infer<typeof InternalActionTypeSchema>;

/**
 * Action returned by agents and nodes.
 *
 * Dispatched through reducers to produce new workflow state. Includes
 * idempotency keys (for replay safety) and optional compensation
 * actions (for the saga rollback pattern).
 */
export const ActionSchema = z.object({
  // ── Identification ──
  /** Unique action identifier. */
  id: z.string().uuid(),
  /** Action type — must be one of the known public action types. */
  type: ActionTypeSchema,
  /** Action payload — shape depends on `type`. */
  payload: z.record(z.string(), z.unknown()),

  // ── Idempotency ──
  /** Deduplication key — prevents re-execution on retry/resume. */
  idempotency_key: z.string(),

  // ── Saga pattern ──
  /** Compensating action for rollback on downstream failure. */
  compensation: z.object({
    type: z.string(),
    payload: z.record(z.string(), z.unknown()),
  }).optional(),

  // ── Subgraph compensation propagation ──
  /** Compensation entries from child subgraph runs to merge into parent. */
  compensation_entries: z.array(z.object({
    action_id: z.string(),
    compensation_action: z.object({
      type: z.string(),
      payload: z.record(z.string(), z.unknown()),
    }),
  })).optional(),

  // ── Metadata ──
  /** Execution metadata for observability and debugging. */
  metadata: z.object({
    /** Node that produced this action. */
    node_id: z.string(),
    /** Agent that produced this action (if agent node). */
    agent_id: z.string().optional(),
    /** When the action was created. Coerced — actions round-trip through jsonb. */
    timestamp: z.coerce.date(),
    /** Retry attempt number (1-based). */
    attempt: z.number().default(1),
    /** Node execution duration in milliseconds. */
    duration_ms: z.number().optional(),
    /** LLM model used for this action (for cost calculation). */
    model: z.string().optional(),
    /** LLM token usage breakdown. */
    token_usage: z.object({
      inputTokens: z.number().optional(),
      outputTokens: z.number().optional(),
      totalTokens: z.number(),
    }).optional(),
    /** Tool calls made during execution. */
    tool_executions: z.array(z.object({
      tool: z.string(),
      args: z.unknown(),
      result: z.unknown(),
    })).optional(),
  }),
});

export type Action = z.infer<typeof ActionSchema>;

// ─── Taint Tracking ─────────────────────────────────────────────────

/**
 * Provenance metadata for a single memory key.
 *
 * Tracked in `memory._taint_registry` to record where each piece of
 * data originated (MCP tool, agent response, derived computation, etc.).
 */
export interface TaintMetadata {
  /** Origin of the data. */
  source: 'mcp_tool' | 'tool_node' | 'agent_response' | 'derived' | 'retrieval';
  /** Tool that produced the data (if `source` is tool-related). */
  tool_name?: string;
  /** MCP server that provided the tool (if `source` is `"mcp_tool"`). */
  server_id?: string;
  /** Agent that produced the data (if `source` is `"agent_response"`). */
  agent_id?: string;
  /** ISO 8601 timestamp (string for JSON serialization). */
  created_at: string;
}

/** Taint registry stored at `memory._taint_registry`. */
export type TaintRegistry = Record<string, TaintMetadata>;

// ─── Lesson Provenance ──────────────────────────────────────────────

/**
 * One retrieval event: the memory facts that were injected into a
 * node's prompt via its `memory_query` directive.
 *
 * Recorded in `memory._lesson_provenance` so that, after the run, a
 * caller can attribute the run's outcome score to the lessons that
 * participated in it (eval-gated learning — see `@cycgraph/memory`'s
 * `OutcomeLedger` / `evaluateRetention`).
 */
export interface LessonProvenanceEntry {
  /** Node whose prompt received the facts. */
  node_id: string;
  /** Agent that executed the node. */
  agent_id?: string;
  /** IDs of the injected facts (only facts whose retriever supplied an id). */
  fact_ids: string[];
  /** ISO 8601 timestamp (string for JSON serialization). */
  retrieved_at: string;
}

/**
 * Lesson provenance registry stored at `memory._lesson_provenance`,
 * keyed by a per-entry UUID so concurrent sibling executions
 * (voting / evolution / map) merge without collisions — same shape
 * discipline as the taint registry.
 */
export type LessonProvenanceRegistry = Record<string, LessonProvenanceEntry>;
