/**
 * Run Context — AsyncLocalStorage for distributed log correlation.
 *
 * Stores `run_id`, `request_id`, `api_key_id`, and `graph_id` in
 * async local storage so they are automatically attached to all log
 * entries without explicit parameter threading.
 *
 * > **Note:** `AsyncLocalStorage` does NOT propagate across `fork()`
 * > boundaries. Child processes must receive the context explicitly
 * > via IPC and call {@link runWithContext} at startup.
 *
 * @module utils/context
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { LogSink } from '../observability/logger.js';

/**
 * Correlation metadata propagated through async call chains.
 */
export interface RunContext {
  /** Unique workflow run identifier. */
  run_id?: string;
  /** Inbound HTTP request identifier. */
  request_id?: string;
  /** Authenticated API key identifier (for audit trails). */
  api_key_id?: string;
  /** Graph being executed. */
  graph_id?: string;
  /**
   * Where log entries for this async chain go. Absent, they go to the process
   * streams. Async-local rather than global, so concurrent runs can send to
   * different destinations without interfering.
   */
  logger?: LogSink;
}

const storage = new AsyncLocalStorage<RunContext>();

/**
 * Execute `fn` within the given context.
 *
 * All async operations initiated by `fn` will see this context
 * via {@link getCurrentContext}.
 *
 * @param ctx - Context to attach to the async call chain.
 * @param fn - Async function to execute within the context.
 * @returns The return value of `fn`.
 */
export function runWithContext<T>(ctx: RunContext, fn: () => Promise<T>): Promise<T> {
  return storage.run(ctx, fn);
}

/**
 * Get the current run context.
 *
 * Returns an empty object if called outside a {@link runWithContext} scope.
 */
export function getCurrentContext(): RunContext {
  return storage.getStore() ?? {};
}
