/**
 * Node Executor Errors
 *
 * Typed errors thrown by node executors. Collected here (mirroring the
 * per-module `errors.ts` convention used across the engine) so executor
 * files stay focused on execution logic.
 *
 * `NodeConfigError` — the most common executor error — lives with the
 * other runner-level errors in `runner/errors.ts`.
 *
 * @module runner/node-executors/errors
 */

import type { VerificationResult } from '../../types/graph.js';
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
