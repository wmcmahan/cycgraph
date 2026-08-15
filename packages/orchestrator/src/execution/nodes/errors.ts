/**
 * Node Executor Errors
 *
 * Typed errors thrown by node executors. Collected here (mirroring the
 * per-module `errors.ts` convention used across the engine) so executor
 * files stay focused on execution logic.
 *
 * `NodeConfigError` — the most common executor error — lives with the
 * other runner-level errors in `execution/errors.ts`.
 *
 * @module execution/nodes/errors
 */

import type { VerificationResult } from '../../graph/graph.js';
import { CycgraphError } from '../../errors.js';

/**
 * Thrown by `executeVerifierNode` when verification fails and the
 * verifier is configured with `throw_on_fail: true`. The node's
 * `failure_policy` decides whether to retry or escalate.
 */
export class VerificationFailedError extends CycgraphError {
  constructor(
    public readonly nodeId: string,
    public readonly result: VerificationResult,
  ) {
    super(`Verification failed for node "${nodeId}": ${result.reasoning}`);
    this.name = 'VerificationFailedError';
  }
}

/**
 * Thrown when a reflection node executes without a `memoryWriter` having
 * been injected on the runner. Reflection requires the writer — there is
 * no useful fallback (in-process memory would be lost on restart).
 */
export class MemoryWriterMissingError extends CycgraphError {
  constructor(public readonly nodeId: string) {
    super(
      `Reflection node "${nodeId}" requires a memoryWriter on GraphRunnerOptions ` +
        `but none was provided`,
    );
    this.name = 'MemoryWriterMissingError';
  }
}

/**
 * Thrown by the subgraph executor when the child run ends in any
 * non-`completed` status (e.g. a rejected nested approval cancelled it) —
 * the nested action was declined, so the parent node fails closed.
 */
export class SubgraphIncompleteError extends CycgraphError {
  constructor(
    public readonly nodeId: string,
    public readonly subgraphId: string,
    public readonly status: string,
  ) {
    super(`Subgraph "${subgraphId}" did not complete (status: ${status})`);
    this.name = 'SubgraphIncompleteError';
  }
}

/**
 * Thrown by the subgraph executor when a value crossing the composition
 * boundary violates the child graph's declared interface — a mapped input
 * fails its schema (or a required input is missing), or a mapped output
 * fails its schema. The boundary is a typed call: declared signature,
 * checked arguments, checked return.
 */
export class SubgraphInterfaceError extends CycgraphError {
  /**
   * Never retried: a schema violation is a property of the value and the
   * declaration, so an identical attempt fails identically.
   */
  readonly retryable = false;

  constructor(
    public readonly nodeId: string,
    public readonly subgraphId: string,
    public readonly direction: 'input' | 'output',
    public readonly key: string,
    detail: string,
  ) {
    super(
      `Subgraph "${subgraphId}" ${direction} "${key}" violates the declared interface: ${detail}`,
    );
    this.name = 'SubgraphInterfaceError';
  }
}

/**
 * Thrown when a value crossing an `a2a` boundary violates a declared
 * schema. Mirrors {@link SubgraphInterfaceError}; kept distinct so a
 * handler can tell a local composition failure from a remote one.
 */
export class A2AInterfaceError extends CycgraphError {
  /** Never retried, for the same reason as {@link SubgraphInterfaceError}. */
  readonly retryable = false;

  constructor(
    public readonly nodeId: string,
    public readonly serverId: string,
    public readonly direction: 'input' | 'output',
    public readonly key: string,
    detail: string,
  ) {
    super(
      `A2A server "${serverId}" ${direction} "${key}" violates the declared interface: ${detail}`,
    );
    this.name = 'A2AInterfaceError';
  }
}

/**
 * Thrown when a remote task ended in any state other than `completed`.
 * `retryable` is `false` for states a retry cannot change; the runner
 * short-circuits on it.
 */
export class A2ATaskFailedError extends CycgraphError {
  readonly retryable?: boolean;
  constructor(
    public readonly nodeId: string,
    public readonly serverId: string,
    public readonly state: string,
    public readonly taskId: string,
    detail?: string,
  ) {
    super(
      `A2A task ${taskId} on server "${serverId}" ended in state "${state}"` +
      (detail ? `: ${detail}` : ''),
    );
    this.name = 'A2ATaskFailedError';
    // A refusal and a bad credential produce identical outcomes on retry.
    if (state === 'rejected' || state === 'auth-required') this.retryable = false;
  }
}
