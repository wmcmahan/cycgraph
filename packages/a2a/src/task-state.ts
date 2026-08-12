/**
 * Task-state translation
 *
 * The protocol's `TaskState` is a protobuf enum, and it reaches this
 * adapter in three spellings depending on the server and the path the value
 * took:
 *
 * - the enum **number** — `Task.fromJSON` yields `7`, not the name. The
 *   live-server harness caught every task normalizing to `failed` when this
 *   table was keyed by names alone.
 * - the proto **name** — `TASK_STATE_REJECTED`
 * - the JSON wire **spelling** — `rejected`, which is also the engine's own
 *   state name
 *
 * Each state appears exactly once below, with its number and proto name on
 * the same row, so the correspondence is checkable at a glance instead of
 * across three separate blocks.
 *
 * @module task-state
 */

import type { A2ATaskState } from '@cycgraph/orchestrator';

/** Number and proto name for each terminal or interrupted engine state. */
const STATE_SPELLINGS: Record<A2ATaskState, readonly [code: string, protoName: string]> = {
  'completed':      ['3', 'TASK_STATE_COMPLETED'],
  'failed':         ['4', 'TASK_STATE_FAILED'],
  'canceled':       ['5', 'TASK_STATE_CANCELED'],
  'input-required': ['6', 'TASK_STATE_INPUT_REQUIRED'],
  'rejected':       ['7', 'TASK_STATE_REJECTED'],
  'auth-required':  ['8', 'TASK_STATE_AUTH_REQUIRED'],
};

/**
 * The two running states, in the same three spellings. They mean "poll
 * again", never "done" — see `settle` in `client.ts`.
 */
const PENDING_SPELLINGS = new Set([
  '1', 'TASK_STATE_SUBMITTED', 'submitted',
  '2', 'TASK_STATE_WORKING', 'working',
]);

const STATE_BY_SPELLING = new Map<string, A2ATaskState>();
for (const [state, [code, protoName]] of Object.entries(STATE_SPELLINGS) as Array<[A2ATaskState, readonly [string, string]]>) {
  STATE_BY_SPELLING.set(code, state);
  STATE_BY_SPELLING.set(protoName, state);
  STATE_BY_SPELLING.set(state, state);
}

/**
 * Normalize a protocol task state to the engine's vocabulary.
 *
 * An unknown state maps to `failed` rather than being passed through: a
 * state we cannot interpret is one we cannot handle correctly, and success
 * would be the dangerous direction to guess in.
 */
export function normalizeState(state: unknown): A2ATaskState {
  return STATE_BY_SPELLING.get(String(state)) ?? 'failed';
}

/** Whether the task is still running and should be polled rather than read. */
export function isPending(state: unknown): boolean {
  return PENDING_SPELLINGS.has(String(state));
}
