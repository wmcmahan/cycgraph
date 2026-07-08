/**
 * Runner Error Types
 *
 * Domain-specific errors thrown by the {@link GraphRunner} when
 * resource limits are exceeded.
 *
 * @module runner/errors
 */

import { CycgraphError } from '../errors.js';

/**
 * Thrown when a workflow exceeds its configured token budget.
 */
export class BudgetExceededError extends CycgraphError {
  constructor(
    /** Tokens consumed at the time of breach. */
    public readonly tokensUsed: number,
    /** The configured budget limit. */
    public readonly budget: number,
  ) {
    super(`Token budget exceeded: ${tokensUsed} tokens used, budget was ${budget}`);
    this.name = 'BudgetExceededError';
  }
}

/**
 * Thrown when a single node execution exceeds its configured `budget`
 * (max_tokens or max_cost_usd). Stops the workflow immediately — does
 * not engage failure_policy retry, since retrying a too-expensive call
 * would just compound the spend.
 */
export class NodeBudgetExceededError extends CycgraphError {
  constructor(
    /** Node identifier that exceeded its budget. */
    public readonly nodeId: string,
    /** Which limit was breached. */
    public readonly limit: 'max_tokens' | 'max_cost_usd',
    /** Observed value at the time of breach. */
    public readonly used: number,
    /** Configured cap on the node. */
    public readonly cap: number,
  ) {
    const unit = limit === 'max_tokens' ? 'tokens' : 'USD';
    super(
      `Node "${nodeId}" exceeded ${limit}: used ${used} ${unit}, cap was ${cap} ${unit}`,
    );
    this.name = 'NodeBudgetExceededError';
  }
}

/**
 * Thrown when a workflow exceeds its configured execution time.
 */
export class WorkflowTimeoutError extends CycgraphError {
  constructor(
    /** The workflow definition ID. */
    public readonly workflowId: string,
    /** The specific run ID that timed out. */
    public readonly runId: string,
    /** Elapsed wall-clock time in milliseconds. */
    public readonly elapsedMs: number,
  ) {
    super(`Workflow ${workflowId} (run ${runId}) timed out after ${elapsedMs}ms`);
    this.name = 'WorkflowTimeoutError';
  }
}

/**
 * Thrown when a node is missing required configuration for its type.
 */
export class NodeConfigError extends CycgraphError {
  constructor(
    public readonly nodeId: string,
    public readonly nodeType: string,
    public readonly missingField: string,
    options?: ErrorOptions,
  ) {
    super(`${nodeType} node "${nodeId}" is missing ${missingField}`, options);
    this.name = 'NodeConfigError';
  }
}

/**
 * Thrown when a circuit breaker is open and the timeout has not elapsed.
 */
export class CircuitBreakerOpenError extends CycgraphError {
  constructor(
    public readonly nodeId: string,
  ) {
    super(`Circuit breaker open for node ${nodeId}`);
    this.name = 'CircuitBreakerOpenError';
  }
}

/**
 * Thrown when event log recovery fails due to missing or corrupt events.
 */
export class EventLogCorruptionError extends CycgraphError {
  constructor(
    public readonly runId: string,
  ) {
    super(`Event log corrupted or incomplete for run ${runId}`);
    this.name = 'EventLogCorruptionError';
  }
}

/**
 * Thrown when a node type is not recognized by the graph runner.
 */
export class UnsupportedNodeTypeError extends CycgraphError {
  constructor(
    public readonly nodeType: string,
  ) {
    super(`Unsupported node type: ${nodeType}`);
    this.name = 'UnsupportedNodeTypeError';
  }
}

/**
 * Thrown when execution reaches a node that is NOT a declared end node, yet
 * has no outgoing edge whose condition matched. Previously the runner
 * silently `_complete`d here, so a typo'd filtrex condition (which evaluates
 * to `false`) or an unexpected memory shape produced a "successful" run that
 * had only executed part of the graph. Failing loud surfaces the dead-end.
 *
 * Opt back into the legacy silent-completion behavior with
 * `GraphRunnerOptions.allowImplicitCompletion = true`.
 */
export class NoMatchingEdgeError extends CycgraphError {
  constructor(
    public readonly nodeId: string,
  ) {
    super(
      `Node '${nodeId}' is not an end node and has no outgoing edge whose ` +
      `condition matched — execution cannot proceed. Check the node's edge ` +
      `conditions, or add it to end_nodes if it is meant to terminate.`,
    );
    this.name = 'NoMatchingEdgeError';
  }
}
