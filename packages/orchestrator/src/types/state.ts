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
  // ── Core metadata ──
  /** Graph definition ID. */
  workflow_id: z.string().uuid(),
  /** Unique run identifier (auto-generated if omitted). */
  run_id: z.string().uuid().default(() => crypto.randomUUID()),
  /** When this run was created (defaults to now). */
  created_at: z.date().default(() => new Date()),
  /** Last state mutation timestamp (defaults to now). */
  updated_at: z.date().default(() => new Date()),

  // ── User input ──
  /** High-level objective for this workflow run. */
  goal: z.string(),
  /** Optional constraints the workflow must respect. */
  constraints: z.array(z.string()).default([]),

  // ── Control flow ──
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
  waiting_since: z.date().optional(),
  /** Deadline after which the wait times out. */
  waiting_timeout_at: z.date().optional(),

  // ── Execution timeouts ──
  /** When `run()` was first invoked. */
  started_at: z.date().optional(),
  /** Wall-clock timeout for the entire run (default: 1 hour). */
  max_execution_time_ms: z.number().default(3_600_000),

  // ── Working memory ──
  /** Dynamic key-value store shared between nodes. */
  memory: z.record(z.string(), z.unknown()).default({}),

  // ── Token budget ──
  /** Cumulative tokens consumed across all LLM calls. */
  total_tokens_used: z.number().default(0),
  /** If set, workflow fails when token usage exceeds this limit. */
  max_token_budget: z.number().optional(),

  // ── Cost tracking (USD) ──
  /** Cumulative estimated cost in USD. */
  total_cost_usd: z.number().default(0),
  /** Per-run cost budget (fail when exceeded). */
  budget_usd: z.number().optional(),
  /** Threshold percentages already fired (prevents duplicate alerts). */
  _cost_alert_thresholds_fired: z.array(z.number()).default([]),

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
    timestamp: z.date(),
  })).default([]),
});

export type WorkflowState = z.infer<typeof WorkflowStateSchema>;

/** Input type for `createWorkflowState()` — only `workflow_id` and `goal` are required. */
export type WorkflowStateInput = z.input<typeof WorkflowStateSchema>;

/**
 * Create a valid WorkflowState with sensible defaults.
 *
 * Only `workflow_id` and `goal` are required. All runtime-managed fields
 * (`run_id`, `created_at`, `status`, `iteration_count`, etc.) are
 * auto-populated via schema defaults.
 *
 * @example
 * ```typescript
 * const state = createWorkflowState({
 *   workflow_id: graph.id,
 *   goal: 'Research and summarize quantum computing',
 *   constraints: ['Under 500 words'],
 *   max_execution_time_ms: 120_000,
 * });
 * ```
 */
export function createWorkflowState(input: WorkflowStateInput): WorkflowState {
  return WorkflowStateSchema.parse(input);
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

export const SetStatusPayloadSchema = z.object({
  status: WorkflowStatusSchema,
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
});
export type HandoffPayload = z.infer<typeof HandoffPayloadSchema>;

export const RequestHumanInputPayloadSchema = z.object({
  waiting_for: WaitingReasonSchema.optional(),
  timeout_ms: z.number().optional(),
  /** Arbitrary review payload. Optional — agents pausing for generic input may omit it. */
  pending_approval: z.unknown().optional(),
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
    /** When the action was created. */
    timestamp: z.date(),
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
  source: 'mcp_tool' | 'tool_node' | 'agent_response' | 'derived';
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
