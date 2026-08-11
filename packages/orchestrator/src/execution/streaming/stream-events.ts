/**
 * Stream Event Types
 *
 * Discriminated union of all events yielded by {@link GraphRunner.stream()}.
 * Terminal events carry the full `WorkflowState`; non-terminal events are
 * lightweight and avoid state cloning overhead.
 *
 * @module execution/streaming/stream-events
 */

import type { WorkflowState } from '../../state/state.js';
import type { ModelResolutionReason, ModelTier } from '../../agents/models/model-resolver.js';

// ─── Non-terminal Events ────────────────────────────────────────────

export interface WorkflowStartEvent {
  type: 'workflow:start';
  workflow_id: string;
  run_id: string;
  timestamp: number;
}

export interface WorkflowRollbackEvent {
  type: 'workflow:rollback';
  workflow_id: string;
  run_id: string;
  timestamp: number;
}

export interface NodeStartEvent {
  type: 'node:start';
  node_id: string;
  node_type: string;
  timestamp: number;
}

export interface NodeCompleteEvent {
  type: 'node:complete';
  node_id: string;
  node_type: string;
  duration_ms: number;
  timestamp: number;
}

export interface NodeFailedEvent {
  type: 'node:failed';
  node_id: string;
  node_type: string;
  error: string;
  attempt: number;
  timestamp: number;
}

export interface NodeRetryEvent {
  type: 'node:retry';
  node_id: string;
  attempt: number;
  backoff_ms: number;
  timestamp: number;
}

/**
 * Diff of memory keys changed by a single action.
 */
export interface MemoryDiff {
  /** Keys that were added (not present before). */
  added: string[];
  /** Keys whose values changed. */
  changed: string[];
  /** Keys that were removed. */
  removed: string[];
  /** New values for added and changed keys. */
  values: Record<string, unknown>;
}

export interface ActionAppliedEvent {
  type: 'action:applied';
  action_id: string;
  action_type: string;
  node_id: string;
  /** Memory diff produced by this action (undefined if no memory changes). */
  memory_diff?: MemoryDiff;
  timestamp: number;
}

export interface StatePersistedEvent {
  type: 'state:persisted';
  run_id: string;
  iteration: number;
  timestamp: number;
}

export interface AgentTokenDeltaEvent {
  type: 'agent:token_delta';
  run_id: string;
  node_id: string;
  token: string;
  timestamp: number;
}

export interface ToolCallStartEvent {
  type: 'tool:call_start';
  run_id: string;
  node_id: string;
  tool_name: string;
  tool_call_id: string;
  args: unknown;
  timestamp: number;
}

export interface ToolCallFinishEvent {
  type: 'tool:call_finish';
  run_id: string;
  node_id: string;
  tool_name: string;
  tool_call_id: string;
  duration_ms: number;
  success: boolean;
  error?: string;
  timestamp: number;
}

export interface ModelResolvedEvent {
  type: 'model:resolved';
  run_id: string;
  node_id: string;
  agent_id: string;
  /** Why this model was chosen. */
  reason: ModelResolutionReason;
  /** The concrete model that will be used. */
  resolved_model: string;
  /** The agent's static fallback model. */
  original_model: string;
  /** The agent's declared capability tier. */
  preference: ModelTier;
  /** Remaining budget at resolution time (undefined = unlimited). */
  remaining_budget_usd?: number;
  timestamp: number;
}

export interface ContextCompressedEvent {
  type: 'context:compressed';
  run_id: string;
  node_id: string;
  tokens_in: number;
  tokens_out: number;
  reduction_percent: number;
  duration_ms: number;
  timestamp: number;
}

export interface BudgetThresholdReachedEvent {
  type: 'budget:threshold_reached';
  run_id: string;
  workflow_id: string;
  threshold_pct: number;
  cost_usd: number;
  budget_usd: number;
  timestamp: number;
}

export interface WorkflowPausedEvent {
  type: 'workflow:paused';
  workflow_id: string;
  run_id: string;
  state: WorkflowState;
  timestamp: number;
}

// ─── Terminal Events (carry WorkflowState) ──────────────────────────

export interface WorkflowCompleteEvent {
  type: 'workflow:complete';
  workflow_id: string;
  run_id: string;
  duration_ms: number;
  state: WorkflowState;
  timestamp: number;
}

export interface WorkflowFailedEvent {
  type: 'workflow:failed';
  workflow_id: string;
  run_id: string;
  error: string;
  state: WorkflowState;
  timestamp: number;
}

export interface WorkflowTimeoutEvent {
  type: 'workflow:timeout';
  workflow_id: string;
  run_id: string;
  elapsed_ms: number;
  state: WorkflowState;
  timestamp: number;
}

export interface WorkflowWaitingEvent {
  type: 'workflow:waiting';
  workflow_id: string;
  run_id: string;
  waiting_for: string;
  state: WorkflowState;
  timestamp: number;
}

// ─── Union ──────────────────────────────────────────────────────────

export type TerminalStreamEvent =
  | WorkflowCompleteEvent
  | WorkflowFailedEvent
  | WorkflowTimeoutEvent
  | WorkflowWaitingEvent;

export interface MemoryDroppedEvent {
  type: 'memory:dropped';
  run_id: string;
  node_id?: string;
  /** The memory key that was dropped from the update. */
  key: string;
  /** Why the value was dropped. */
  reason: 'oversized' | 'non_serializable' | 'reserved_key';
  /** Serialized size in bytes (only set when `reason === 'oversized'`). */
  bytes?: number;
  timestamp: number;
}

export type StreamEvent =
  | WorkflowStartEvent
  | WorkflowCompleteEvent
  | WorkflowFailedEvent
  | WorkflowTimeoutEvent
  | WorkflowWaitingEvent
  | WorkflowPausedEvent
  | WorkflowRollbackEvent
  | NodeStartEvent
  | NodeCompleteEvent
  | NodeFailedEvent
  | NodeRetryEvent
  | ActionAppliedEvent
  | StatePersistedEvent
  | AgentTokenDeltaEvent
  | ToolCallStartEvent
  | ToolCallFinishEvent
  | BudgetThresholdReachedEvent
  | ModelResolvedEvent
  | ContextCompressedEvent
  | MemoryDroppedEvent;

/**
 * Type guard: narrows to terminal events that carry `state: WorkflowState`.
 */
export function isTerminalEvent(event: StreamEvent): event is TerminalStreamEvent {
  return (
    event.type === 'workflow:complete' ||
    event.type === 'workflow:failed' ||
    event.type === 'workflow:timeout' ||
    event.type === 'workflow:waiting'
  );
}
