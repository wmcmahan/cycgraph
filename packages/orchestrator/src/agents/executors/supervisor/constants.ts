/**
 * Supervisor Executor Constants
 *
 * @module supervisor-executor/constants
 */

/**
 * Sentinel value indicating the supervisor considers the workflow complete.
 *
 * When the LLM returns this as `next_node`, the executor produces a
 * `set_status: completed` action instead of a handoff.
 */
export const SUPERVISOR_DONE = '__done__';
