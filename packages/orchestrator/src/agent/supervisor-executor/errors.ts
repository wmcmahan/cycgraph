/**
 * Custom error classes for the supervisor executor subsystem.
 *
 * @module supervisor-executor/errors
 */

import { CycgraphError } from '../../errors.js';

/**
 * Thrown when a supervisor node is missing its required `supervisor_config`.
 *
 * @example
 * ```ts
 * throw new SupervisorConfigError('sup-1', 'supervisor_config is required');
 * ```
 */
export class SupervisorConfigError extends CycgraphError {
  constructor(
    public readonly supervisorId: string,
    message: string,
  ) {
    super(`Supervisor config error (${supervisorId}): ${message}`);
    this.name = 'SupervisorConfigError';
  }
}

/**
 * Thrown when the LLM routes to a node not in the `managed_nodes` allowlist.
 *
 * This is a security boundary — the supervisor must only delegate to
 * nodes it has been explicitly configured to manage.
 *
 * @example
 * ```ts
 * throw new SupervisorRoutingError('sup-1', 'rogue-node', ['worker-a', 'worker-b']);
 * ```
 */
export class SupervisorRoutingError extends CycgraphError {
  constructor(
    public readonly supervisorId: string,
    public readonly chosenNode: string,
    public readonly allowedNodes: string[],
  ) {
    super(
      `Supervisor "${supervisorId}" tried to route to "${chosenNode}" which is not in managed_nodes: [${allowedNodes.join(', ')}]`
    );
    this.name = 'SupervisorRoutingError';
  }
}
