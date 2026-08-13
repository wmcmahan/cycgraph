/**
 * Workflow State Reducers
 *
 * Pure functions that produce new state from `(State, Action)` pairs.
 * The {@link GraphRunner} dispatches actions through these reducers to
 * advance workflow execution.
 *
 * Two categories:
 *
 * 1. **Public reducers** — applied via {@link rootReducer} for agent-generated
 *    actions. Subject to permission checks via {@link validateAction}.
 * 2. **Internal reducer** — {@link internalReducer} handles runner-controlled
 *    lifecycle transitions (init, complete, fail, etc.). These bypass
 *    permission checks since they are trusted internal operations.
 *
 * All reducers are pure: they never mutate the input state.
 *
 * @module state/reducers
 */

import type { WorkflowState, Action, WaitingReason, InternalActionType } from './state.js';
import {
  UpdateMemoryPayloadSchema,
  SetStatusPayloadSchema,
  GotoNodePayloadSchema,
  HandoffPayloadSchema,
  RequestHumanInputPayloadSchema,
  ResumeFromHumanPayloadSchema,
  MergeParallelResultsPayloadSchema,
} from './state.js';
import {
  MAX_MEMORY_VALUE_BYTES,
  MAX_SUPERVISOR_HISTORY,
  MAX_VISITED_NODES,
  MAX_MEMORY_DROPS,
} from '../runtime-config.js';
import {
  LESSON_PROVENANCE_KEY,
  mergeLessonProvenance,
} from '../memory/lesson-provenance.js';
import type { LessonProvenanceRegistry, TaintRegistry } from './state.js';
import { canTransitionStatus } from './status-transitions.js';
import { createLogger } from '../observability/logger.js';

export { canTransitionStatus, isTerminalStatus, TERMINAL_STATUSES } from './status-transitions.js';

const logger = createLogger('reducers.status');

/**
 * Apply a status change (plus any accompanying field updates) only if the
 * transition is legal. An illegal transition — always a move *out of* a frozen
 * terminal state — is a no-op: the whole action is dropped so a resurrected run
 * can't appear. See {@link canTransitionStatus}.
 */
function transitionStatus(
  state: WorkflowState,
  to: WorkflowState['status'],
  action: Action,
  extraFields: Partial<WorkflowState> = {},
): WorkflowState {
  if (!canTransitionStatus(state.status, to)) {
    logger.warn('illegal_status_transition_blocked', {
      from: state.status,
      to,
      action_type: action.type,
    });
    return state;
  }
  return { ...state, ...extraFields, status: to, updated_at: timeOf(action) };
}

/**
 * Reducer function signature.
 *
 * Pure function: `(State, Action) → NewState`.
 * Must return the original state unchanged for unrecognised action types.
 */
export type Reducer = (state: WorkflowState, action: Action) => WorkflowState;

/**
 * Version of the reducer semantics used for event-log replay.
 *
 * Stamped onto the `workflow_started` event so recovery can detect when a
 * log written by a different engine version is replayed through reducers
 * whose semantics may have changed. Bump this whenever a reducer's
 * observable state transitions change.
 */
export const REPLAY_VERSION = 2;

/**
 * Derive the logical time of an action from its metadata timestamp.
 *
 * Reducers MUST use this instead of `new Date()` so that event-log replay
 * is deterministic: replaying a stored action reproduces the exact same
 * `started_at` / `updated_at` / `waiting_timeout_at` values as the live run.
 * Tolerates string timestamps (actions round-tripped through JSON/jsonb).
 */
function timeOf(action: Action): Date {
  const t = action.metadata?.timestamp;
  if (t instanceof Date) return t;
  if (typeof t === 'string' || typeof t === 'number') {
    const parsed = new Date(t);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date();
}

// Re-export from runtime-config so existing consumers of `state/reducers.ts`
// don't break. Prefer importing from `runtime-config.js` in new code.
export { MAX_SUPERVISOR_HISTORY, MAX_VISITED_NODES, MAX_MEMORY_DROPS };

/**
 * Record of a single memory update rejected by {@link filterOversizedValues}.
 *
 * Reducers append these to `state.memory_drops` (bounded by {@link MAX_MEMORY_DROPS})
 * so callers can inspect them post-run. The {@link GraphRunner} also emits a
 * `memory:dropped` stream event for each new drop — see `stream-events.ts`.
 */
export interface MemoryDropRecord {
  key: string;
  reason: 'oversized' | 'non_serializable' | 'reserved_key';
  bytes?: number;
  node_id?: string;
  timestamp: Date;
}

/**
 * Filter out memory values that exceed {@link MAX_MEMORY_VALUE_BYTES} or that
 * cannot be serialised to JSON. Returns the safe subset alongside a structured
 * record of every drop so the reducer can append it to `state.memory_drops`.
 *
 * Reducers stay pure: drops are surfaced via returned data, not side effects.
 */
function filterOversizedValues(
  updates: Record<string, unknown>,
  nodeId?: string,
  now: Date = new Date(),
): { filtered: Record<string, unknown>; drops: MemoryDropRecord[] } {
  const filtered: Record<string, unknown> = {};
  const drops: MemoryDropRecord[] = [];
  for (const [key, value] of Object.entries(updates)) {
    try {
      const serialized = JSON.stringify(value);
      if (serialized !== undefined && serialized.length > MAX_MEMORY_VALUE_BYTES) {
        drops.push({ key, reason: 'oversized', bytes: serialized.length, node_id: nodeId, timestamp: now });
        continue;
      }
    } catch {
      drops.push({ key, reason: 'non_serializable', node_id: nodeId, timestamp: now });
      continue;
    }
    filtered[key] = value;
  }
  return { filtered, drops };
}

/**
 * Append memory drop records to a state's ring buffer, keeping only the most
 * recent {@link MAX_MEMORY_DROPS} entries.
 */
function appendMemoryDrops(existing: MemoryDropRecord[] | undefined, drops: MemoryDropRecord[]): MemoryDropRecord[] {
  const base = existing ?? [];
  if (drops.length === 0) return base;
  const merged = [...base, ...drops];
  return merged.length > MAX_MEMORY_DROPS ? merged.slice(-MAX_MEMORY_DROPS) : merged;
}

/** Append a node ID to visited_nodes, keeping only the last MAX_VISITED_NODES entries. */
function appendVisited(visited: string[], nodeId: string): string[] {
  const next = [...visited, nodeId];
  return next.length > MAX_VISITED_NODES ? next.slice(-MAX_VISITED_NODES) : next;
}

/**
 * Coerce a usage payload value to a finite, non-negative number. A `NaN` or
 * `undefined` from malformed provider usage must not reach the running totals:
 * a single NaN makes `total_tokens_used` / `total_cost_usd` NaN, and since
 * every `NaN > budget` comparison is false, budget enforcement would silently
 * never fire again (same defense as `sanitizeTokens` in cost/pricing.ts).
 */
function finiteOr0(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
}

/** WIRE key for the taint registry inside action payload `updates`. */
const TAINT_REGISTRY_KEY = '_taint_registry';
/** WIRE key for the swarm handoff counter inside handoff `memory_updates`. */
const SWARM_HANDOFF_COUNT_KEY = '_swarm_handoff_count';
/** WIRE key prefix for subgraph child checkpoints inside HITL `memory_updates`. */
const SUBGRAPH_RESUME_PREFIX = '_subgraph_resume_';

/**
 * The system-field portion of a routed memory update, ready to spread
 * over state. `undefined` fields mean "unchanged".
 */
interface RoutedSystemUpdates {
  /** User-space updates (no `_`-prefixed keys) — go to `state.memory`. */
  user: Record<string, unknown>;
  /** New taint entries — appended to `state.taint_registry`. */
  taint?: TaintRegistry;
  /** New provenance entries — appended to `state.lesson_provenance`. */
  provenance?: LessonProvenanceRegistry;
  /** Updated swarm handoff counter. */
  swarmHandoffCount?: number;
  /** Subgraph checkpoint writes (value `undefined` = clear the stash). */
  subgraphCheckpoints?: Record<string, unknown>;
  /** Unknown `_` keys rejected fail-closed. */
  drops: MemoryDropRecord[];
}

/**
 * Route a memory-updates payload into user memory vs engine-owned state
 * fields. This is THE choke point for the system/user namespace split:
 *
 *  - `_taint_registry` / `_lesson_provenance` — legacy wire encodings from
 *    executors, routed to their state fields, **append-only** (a crafted
 *    `{ _taint_registry: {} }` cannot clear taint; provenance likewise).
 *  - `_swarm_handoff_count` / `_subgraph_resume_*` — pattern/control-flow
 *    wire keys, routed to their state fields.
 *  - Any OTHER `_`-prefixed key is dropped fail-closed and recorded in
 *    `memory_drops` with reason `reserved_key` — the underscore namespace is
 *    reserved for the engine, and an unknown key in it is either a typo or a
 *    smuggling attempt. Applies uniformly to every memory-merge channel
 *    (update_memory, merge_parallel_results, handoff, HITL), so a new
 *    channel can never reopen the hole.
 */
function routeSystemUpdates(
  updates: Record<string, unknown>,
  nodeId: string | undefined,
  now: Date,
): RoutedSystemUpdates {
  const routed: RoutedSystemUpdates = { user: {}, drops: [] };

  for (const [key, value] of Object.entries(updates)) {
    if (!key.startsWith('_')) {
      routed.user[key] = value;
      continue;
    }
    if (key === TAINT_REGISTRY_KEY) {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        routed.taint = { ...(routed.taint ?? {}), ...(value as TaintRegistry) };
      }
      continue;
    }
    if (key === LESSON_PROVENANCE_KEY) {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        routed.provenance = { ...(routed.provenance ?? {}), ...(value as LessonProvenanceRegistry) };
      }
      continue;
    }
    if (key === SWARM_HANDOFF_COUNT_KEY) {
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
        routed.swarmHandoffCount = value;
      }
      continue;
    }
    if (key.startsWith(SUBGRAPH_RESUME_PREFIX)) {
      const checkpointNodeId = key.slice(SUBGRAPH_RESUME_PREFIX.length);
      routed.subgraphCheckpoints = {
        ...(routed.subgraphCheckpoints ?? {}),
        [checkpointNodeId]: value,
      };
      continue;
    }
    routed.drops.push({ key, reason: 'reserved_key', node_id: nodeId, timestamp: now });
    logger.warn('reserved_memory_key_dropped', { key, node_id: nodeId });
  }

  return routed;
}

/**
 * Apply the system-field portion of a routed update to state. Registries
 * are append-only; checkpoints support explicit clearing.
 */
function applySystemUpdates(
  state: WorkflowState,
  routed: RoutedSystemUpdates,
): Pick<WorkflowState, 'taint_registry' | 'lesson_provenance' | 'swarm_handoff_count' | 'subgraph_checkpoints'> {
  let checkpoints = state.subgraph_checkpoints;
  if (routed.subgraphCheckpoints) {
    checkpoints = { ...checkpoints };
    for (const [nodeId, value] of Object.entries(routed.subgraphCheckpoints)) {
      if (value === undefined) delete checkpoints[nodeId];
      else checkpoints[nodeId] = value;
    }
  }
  return {
    taint_registry: routed.taint
      ? { ...state.taint_registry, ...routed.taint }
      : state.taint_registry,
    lesson_provenance: mergeLessonProvenance(state.lesson_provenance, routed.provenance),
    swarm_handoff_count: routed.swarmHandoffCount ?? state.swarm_handoff_count,
    subgraph_checkpoints: checkpoints,
  };
}

// ─── Public Reducers ────────────────────────────────────────────────

/**
 * Merge key-value updates into workflow memory.
 *
 * Action type: `update_memory`
 * Payload: `{ updates: Record<string, unknown> }`
 */
export const updateMemoryReducer: Reducer = (state, action) => {
  if (action.type !== 'update_memory') return state;

  const { updates } = UpdateMemoryPayloadSchema.parse(action.payload);
  const routed = routeSystemUpdates(updates, action.metadata?.node_id, timeOf(action));
  // Size caps apply to USER memory only — the engine registries are bounded
  // by their own mechanisms (append-only entries, provenance ring buffer).
  const { filtered, drops } = filterOversizedValues(routed.user, action.metadata?.node_id, timeOf(action));

  return {
    ...state,
    memory: { ...state.memory, ...filtered },
    ...applySystemUpdates(state, routed),
    memory_drops: appendMemoryDrops(state.memory_drops, [...routed.drops, ...drops]),
    updated_at: timeOf(action),
  };
};

/**
 * Set the workflow status.
 *
 * Action type: `set_status`
 * Payload: `{ status: WorkflowState['status'] }`
 */
export const setStatusReducer: Reducer = (state, action) => {
  if (action.type !== 'set_status') return state;

  const { status, lesson_provenance } = SetStatusPayloadSchema.parse(action.payload);

  // Guarded: a terminal run can't be moved back to an active status.
  const transitioned = transitionStatus(state, status, action);

  // A supervisor's completion action carries the provenance of facts
  // injected into its routing prompt — merge it append-only so supervisor
  // retrieval is attributable to the run's outcome, same as agent nodes.
  if (!lesson_provenance) return transitioned;
  return {
    ...transitioned,
    lesson_provenance: mergeLessonProvenance(transitioned.lesson_provenance, lesson_provenance),
  };
};

/**
 * Navigate to the next node in the graph.
 *
 * Action type: `goto_node`
 * Payload: `{ node_id: string }`
 */
export const gotoNodeReducer: Reducer = (state, action) => {
  if (action.type !== 'goto_node') return state;

  const { node_id } = GotoNodePayloadSchema.parse(action.payload);

  return {
    ...state,
    current_node: node_id,
    visited_nodes: appendVisited(state.visited_nodes, node_id),
    updated_at: timeOf(action),
  };
};

/**
 * Supervisor handoff — route execution to a managed node.
 *
 * Action type: `handoff`
 * Payload: `{ node_id: string, supervisor_id: string, reasoning: string }`
 */
export const handoffReducer: Reducer = (state, action) => {
  if (action.type !== 'handoff') return state;

  const { node_id, supervisor_id, reasoning, lesson_provenance, memory_updates } =
    HandoffPayloadSchema.parse(action.payload);

  const newHistory = [
    ...state.supervisor_history,
    {
      supervisor_id,
      delegated_to: node_id,
      reasoning,
      iteration: state.iteration_count,
      timestamp: timeOf(action),
    },
  ];

  // Swarm handoffs carry the delegating agent's output (plus the incremented
  // handoff counter) in `memory_updates`. Routed through the same choke point
  // as `update_memory` — without this merge, the agent's work was silently
  // dropped and `max_handoffs` never bound.
  const routed = routeSystemUpdates(memory_updates ?? {}, action.metadata?.node_id, timeOf(action));
  const { filtered, drops } = filterOversizedValues(routed.user, action.metadata?.node_id, timeOf(action));
  const systemFields = applySystemUpdates(state, routed);

  return {
    ...state,
    current_node: node_id,
    visited_nodes: appendVisited(state.visited_nodes, node_id),
    supervisor_history: newHistory.length > MAX_SUPERVISOR_HISTORY
      ? newHistory.slice(-MAX_SUPERVISOR_HISTORY)
      : newHistory,
    memory: { ...state.memory, ...filtered },
    ...systemFields,
    // Carry the supervisor's injected-fact provenance, append-only, so the
    // facts that shaped this routing decision are attributable to the run.
    lesson_provenance: mergeLessonProvenance(systemFields.lesson_provenance, lesson_provenance),
    memory_drops: appendMemoryDrops(state.memory_drops, [...routed.drops, ...drops]),
    updated_at: timeOf(action),
  };
};

/**
 * Pause the workflow to request human input.
 *
 * Action type: `request_human_input`
 * Payload: `{ waiting_for?: WaitingReason, timeout_ms?: number, pending_approval: unknown }`
 *
 * Default timeout: 24 hours.
 */
export const requestHumanInputReducer: Reducer = (state, action) => {
  if (action.type !== 'request_human_input') return state;

  const parsed = RequestHumanInputPayloadSchema.parse(action.payload);
  // Logical time from the action, not wall clock: replaying this action must
  // reproduce the original approval deadline, not extend it.
  const now = timeOf(action);
  const timeout_ms = parsed.timeout_ms || 86_400_000;

  // Extra memory (e.g. a subgraph child checkpoint) goes through the same
  // routing choke point as every other memory merge: registries stay
  // append-only and checkpoints land in `subgraph_checkpoints` — where the
  // per-value size cap deliberately does not apply (a child checkpoint can
  // legitimately be large). User keys are size-filtered as usual.
  const routed = routeSystemUpdates(
    parsed.memory_updates && typeof parsed.memory_updates === 'object' ? parsed.memory_updates : {},
    action.metadata?.node_id,
    now,
  );
  const { filtered, drops } = filterOversizedValues(routed.user, action.metadata?.node_id, now);

  // Guarded: don't move a terminal run into `waiting`.
  return transitionStatus(state, 'waiting', action, {
    waiting_for: (parsed.waiting_for as WaitingReason) || 'human_approval',
    waiting_since: now,
    waiting_timeout_at: new Date(now.getTime() + timeout_ms),
    memory: { ...state.memory, ...filtered },
    ...applySystemUpdates(state, routed),
    // First-class field — structurally outside the blackboard, so
    // `memory_updates` can never overwrite it.
    pending_approval: parsed.pending_approval,
    memory_drops: appendMemoryDrops(state.memory_drops, [...routed.drops, ...drops]),
  });
};

/**
 * Resume the workflow after human input is received.
 *
 * Clears waiting state and merges the human's response, decision,
 * and any additional memory updates. Clears the first-class
 * `pending_approval` field.
 *
 * Action type: `resume_from_human`
 * Payload: `{ response: unknown, decision: unknown, memory_updates?: Record<string, unknown> }`
 */
export const resumeFromHumanReducer: Reducer = (state, action) => {
  if (action.type !== 'resume_from_human') return state;

  const parsed = ResumeFromHumanPayloadSchema.parse(action.payload);

  const memoryUpdates: Record<string, unknown> = {
    human_response: parsed.response,
    human_decision: parsed.decision,
  };

  if (parsed.memory_updates && typeof parsed.memory_updates === 'object') {
    Object.assign(memoryUpdates, parsed.memory_updates);
  }

  const routed = routeSystemUpdates(memoryUpdates, action.metadata?.node_id, timeOf(action));
  const { filtered, drops } = filterOversizedValues(routed.user, action.metadata?.node_id, timeOf(action));

  // Guarded: a run that reached a terminal state (e.g. timed out while waiting)
  // can't be resumed back to `running`. The routing choke point keeps the
  // taint / lesson-provenance registries append-only against a crafted
  // resume payload.
  return transitionStatus(state, 'running', action, {
    waiting_for: undefined,
    waiting_since: undefined,
    waiting_timeout_at: undefined,
    pending_approval: undefined,
    memory: { ...state.memory, ...filtered },
    ...applySystemUpdates(state, routed),
    memory_drops: appendMemoryDrops(state.memory_drops, [...routed.drops, ...drops]),
  });
};

/**
 * Merge parallel execution results into memory and accumulate token usage.
 *
 * Action type: `merge_parallel_results`
 * Payload: `{ updates: Record<string, unknown>, total_tokens?: number }`
 */
export const mergeParallelResultsReducer: Reducer = (state, action) => {
  if (action.type !== 'merge_parallel_results') return state;

  const { updates } = MergeParallelResultsPayloadSchema.parse(action.payload);
  const routed = routeSystemUpdates(updates, action.metadata?.node_id, timeOf(action));
  const { filtered, drops } = filterOversizedValues(routed.user, action.metadata?.node_id, timeOf(action));

  // Token accounting is intentionally NOT done here. The runner dispatches a
  // separate `_track_tokens` internal action from `action.metadata.token_usage`
  // for every fan-out action (map/voting/evolution), and that action is the
  // sole accountant for total/input/output tokens — both live and on replay
  // (both `action_dispatched` and `internal_dispatched` events are always
  // emitted together and replayed). Adding `payload.total_tokens` here too
  // double-counted `total_tokens_used` (tripping the token budget at half the
  // real budget) while input/output were counted once — an inconsistent state.
  return {
    ...state,
    memory: { ...state.memory, ...filtered },
    ...applySystemUpdates(state, routed),
    memory_drops: appendMemoryDrops(state.memory_drops, [...routed.drops, ...drops]),
    updated_at: timeOf(action),
  };
};

// ─── Root Reducer ───────────────────────────────────────────────────

/** All public reducers, applied in sequence by {@link rootReducer}. */
const PUBLIC_REDUCERS: readonly Reducer[] = [
  updateMemoryReducer,
  setStatusReducer,
  gotoNodeReducer,
  handoffReducer,
  requestHumanInputReducer,
  resumeFromHumanReducer,
  mergeParallelResultsReducer,
];

/**
 * Composite reducer — applies all public reducers in sequence.
 *
 * Each reducer checks the action type and returns state unchanged if
 * it doesn't match, so exactly one reducer will handle each action.
 */
export const rootReducer: Reducer = (state, action) => {
  return PUBLIC_REDUCERS.reduce<WorkflowState>((s, reducer) => reducer(s, action), state);
};

// ─── Internal Reducer ───────────────────────────────────────────────

/**
 * Internal reducer for runner-controlled lifecycle transitions.
 *
 * Handles status changes, node advancement, token/cost tracking,
 * and compensation stack management. These actions are prefixed with
 * `_` and bypass permission checks since they are trusted operations
 * dispatched only by the {@link GraphRunner}.
 */
export const internalReducer: Reducer = (state, action) => {
  // Internal actions have `_`-prefixed types that are not in ActionTypeSchema.
  // They are constructed via dispatchInternal() with a type cast and bypass
  // ActionSchema validation. We use InternalActionType for the switch.
  // All time derivations use timeOf(action) — never wall clock — so that
  // replaying the event log reconstructs byte-identical state (started_at,
  // updated_at, deadlines) regardless of when the replay happens.
  switch (action.type as InternalActionType) {
    case '_init': {
      const now = timeOf(action);
      if (action.payload.resume === true) {
        // Guarded: never resurrect a terminal run on resume/replay.
        return transitionStatus(state, 'running', action);
      }
      const startNode = action.payload.start_node as string;
      return transitionStatus(state, 'running', action, {
        current_node: startNode,
        visited_nodes: appendVisited(state.visited_nodes, startNode),
        started_at: now,
      });
    }

    case '_fail':
      // Guarded: don't overwrite an existing terminal status (e.g. a late
      // failure after the run already completed).
      return transitionStatus(state, 'failed', action, {
        last_error: action.payload.last_error as string,
      });

    case '_complete':
      return transitionStatus(state, 'completed', action);

    case '_advance': {
      const nodeId = action.payload.node_id as string;
      return {
        ...state,
        current_node: nodeId,
        visited_nodes: appendVisited(state.visited_nodes, nodeId),
        updated_at: timeOf(action),
      };
    }

    case '_timeout':
      return transitionStatus(state, 'timeout', action);

    case '_cancel':
      return transitionStatus(state, 'cancelled', action);

    case '_track_tokens': {
      const tokens = finiteOr0(action.payload.tokens);
      const inputTokens = finiteOr0(action.payload.input_tokens);
      const outputTokens = finiteOr0(action.payload.output_tokens);
      return {
        ...state,
        total_tokens_used: (state.total_tokens_used || 0) + tokens,
        total_input_tokens: (state.total_input_tokens || 0) + inputTokens,
        total_output_tokens: (state.total_output_tokens || 0) + outputTokens,
        updated_at: timeOf(action),
      };
    }

    case '_track_cost': {
      const costUsd = finiteOr0(action.payload.cost_usd);
      return {
        ...state,
        total_cost_usd: (state.total_cost_usd ?? 0) + costUsd,
        updated_at: timeOf(action),
      };
    }

    case '_track_model_usage': {
      const model = action.payload.model as string;
      const inputTokens = finiteOr0(action.payload.input_tokens);
      const outputTokens = finiteOr0(action.payload.output_tokens);
      const costUsd = finiteOr0(action.payload.cost_usd);
      const prev = state.model_breakdown?.[model] ?? {
        input_tokens: 0,
        output_tokens: 0,
        cost_usd: 0,
        calls: 0,
      };
      return {
        ...state,
        model_breakdown: {
          ...state.model_breakdown,
          [model]: {
            input_tokens: prev.input_tokens + inputTokens,
            output_tokens: prev.output_tokens + outputTokens,
            cost_usd: prev.cost_usd + costUsd,
            calls: prev.calls + 1,
          },
        },
        updated_at: timeOf(action),
      };
    }

    case '_fire_cost_threshold': {
      const threshold = action.payload.threshold as number;
      return {
        ...state,
        _cost_alert_thresholds_fired: [...(state._cost_alert_thresholds_fired ?? []), threshold],
        updated_at: timeOf(action),
      };
    }

    case '_budget_exceeded':
      return transitionStatus(state, 'failed', action, {
        last_error: action.payload.last_error as string,
      });

    case '_push_compensation':
      return {
        ...state,
        compensation_stack: [
          ...state.compensation_stack,
          {
            action_id: action.payload.action_id as string,
            compensation_action: action.payload.compensation_action as { type: string; payload: Record<string, unknown> },
          },
        ],
        updated_at: timeOf(action),
      };

    case '_increment_iteration':
      return {
        ...state,
        iteration_count: state.iteration_count + 1,
        updated_at: timeOf(action),
      };

    case '_pop_compensation': {
      const stack = [...state.compensation_stack];
      stack.pop();
      return {
        ...state,
        compensation_stack: stack,
        updated_at: timeOf(action),
      };
    }

    default:
      return state;
  }
};

// ─── Permission Validation ──────────────────────────────────────────

/**
 * Validate that an agent has permission to dispatch a given action.
 *
 * Checks the action's required keys against the agent's `write_keys`
 * permissions. The wildcard `'*'` grants all permissions.
 *
 * @param action - The action to validate.
 * @param allowedKeys - The agent's allowed write keys.
 * @returns `true` if the action is permitted, `false` otherwise.
 */
export function validateAction(
  action: Action,
  allowedKeys: string[]
): boolean {
  switch (action.type) {
    case 'update_memory': {
      const { updates } = UpdateMemoryPayloadSchema.parse(action.payload);
      // Exclude _-prefixed system keys (e.g. _taint_registry) from permission
      // checks — they are injected by the executor, not authored by the agent.
      // Agent-level validation in validateMemoryUpdatePermissions already
      // blocks agents from writing _-prefixed keys directly.
      const keys = Object.keys(updates).filter(k => !k.startsWith('_'));
      return allowedKeys.includes('*') || keys.every(k => allowedKeys.includes(k));
    }

    case 'set_status':
      return allowedKeys.includes('*') || allowedKeys.includes('status');

    case 'goto_node':
    case 'handoff':
    case 'request_human_input':
    case 'resume_from_human':
      return allowedKeys.includes('*') || allowedKeys.includes('control_flow');

    case 'merge_parallel_results': {
      const { updates: parallelUpdates } = MergeParallelResultsPayloadSchema.parse(action.payload);
      const parallelKeys = Object.keys(parallelUpdates).filter(k => !k.startsWith('_'));
      return allowedKeys.includes('*') || parallelKeys.every(k => allowedKeys.includes(k));
    }

    default:
      // Unknown action types are rejected for safety (deny-by-default)
      return false;
  }
}
