/**
 * Subgraph Node Executor
 *
 * Executes a nested workflow (subgraph) as a single node. Memory is
 * mapped between parent and child scopes via `input_mapping` and
 * `output_mapping`. Includes cycle detection to prevent infinite
 * subgraph recursion.
 *
 * @module execution/nodes/subgraph
 */

import type { GraphNode } from '../../graph/graph.js';
import type { Action, WorkflowState, StateView } from '../../state/state.js';
import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../../observability/logger.js';
import { getTracer, withSpan } from '../../observability/tracing.js';
import { NodeConfigError } from '../errors.js';
import {
  mapInbound,
  mapOutbound,
  validateInbound,
  type BoundaryFailure,
} from './boundary.js';
import type { NodeExecutorContext } from './context.js';
import { nodeIdempotencyKey } from './idempotency-key.js';
import { SubgraphIncompleteError, SubgraphInterfaceError } from './errors.js';
import { intersectCeilings } from '../../tools/registry.js';
import { childEventLogWriter } from '../coordination/child-events.js';

const logger = createLogger('runner.node.subgraph');
const tracer = getTracer('orchestrator.subgraph');

/**
 * Maximum nesting depth for subgraphs. Cycle detection only blocks revisiting
 * the SAME subgraph id; a chain of DISTINCT subgraphs (g1 → g2 → … → gN) would
 * otherwise recurse until native stack/heap exhaustion (DoS). 32 is far beyond
 * any legitimate composition depth.
 */
const MAX_SUBGRAPH_DEPTH = 32;

/**
 * Validate one boundary value against a declared JSON Schema. Returns an
 * error detail string on violation, `null` on pass. Schemas the converter
 * can't express degrade to `z.any()`, so an exotic schema never blocks a
 * valid value.
 */
/**
 * Revive a stashed child checkpoint after a DB round-trip (JSON turns Dates
 * into strings). We can't use `WorkflowStateSchema.parse` here — a subgraph
 * child's `workflow_id` is the subgraph slug, not a UUID, so strict validation
 * would reject a legitimate state. Coerce only the top-level Date fields the
 * runner reads on resume.
 */
function reviveChildState(raw: unknown): WorkflowState {
  const s = raw as Record<string, unknown>;
  const d = (v: unknown) => (typeof v === 'string' ? new Date(v) : v);
  return {
    ...(s as object),
    created_at: d(s.created_at),
    updated_at: d(s.updated_at),
    ...(s.started_at != null ? { started_at: d(s.started_at) } : {}),
    ...(s.waiting_since != null ? { waiting_since: d(s.waiting_since) } : {}),
    ...(s.waiting_timeout_at != null ? { waiting_timeout_at: d(s.waiting_timeout_at) } : {}),
  } as WorkflowState;
}

/**
 * Execute a subgraph node (nested workflow composition).
 *
 * Builds an isolated child state, runs a new {@link GraphRunner}
 * instance, and maps the child's output memory back to the parent.
 *
 * @param node - Subgraph node with `subgraph_config`.
 * @param stateView - Filtered state view from the parent workflow.
 * @param attempt - Retry attempt number.
 * @param ctx - Executor context (must include `loadGraphFn`).
 * @returns `update_memory` action with mapped child outputs.
 * @throws If `subgraph_config` is missing, `loadGraphFn` is not provided,
 *         the subgraph is not found, or a subgraph cycle is detected.
 */
export async function executeSubgraphNode(
  node: GraphNode,
  stateView: StateView,
  attempt: number,
  ctx: NodeExecutorContext,
): Promise<Action> {
  const config = node.subgraph_config;
  if (!config) {
    throw new NodeConfigError(node.id, 'subgraph', 'subgraph_config');
  }

  if (!ctx.loadGraphFn) {
    throw new NodeConfigError(node.id, 'subgraph', 'loadGraphFn');
  }

  logger.info('subgraph_executing', { node_id: node.id, subgraph_id: config.subgraph_id });

  // Cycle detection: prevent A → B → A recursion. Reads the ancestor chain
  // from the first-class `subgraph_stack` state field.
  const subgraphStack = ctx.state.subgraph_stack ?? [];
  if (subgraphStack.includes(config.subgraph_id)) {
    throw new NodeConfigError(node.id, 'subgraph', `non-cyclic graph (cycle: ${[...subgraphStack, config.subgraph_id].join(' -> ')})`);
  }

  // Depth cap: a chain of distinct subgraphs passes cycle detection but can
  // still recurse without bound. Refuse beyond MAX_SUBGRAPH_DEPTH.
  if (subgraphStack.length >= MAX_SUBGRAPH_DEPTH) {
    throw new NodeConfigError(
      node.id,
      'subgraph',
      `subgraph nesting within depth limit (${MAX_SUBGRAPH_DEPTH}); current chain: ${[...subgraphStack, config.subgraph_id].join(' -> ')}`,
    );
  }

  const childGraph = await ctx.loadGraphFn(config.subgraph_id);
  if (!childGraph) {
    throw new NodeConfigError(node.id, 'subgraph', `graph "${config.subgraph_id}"`);
  }

  // Crossing INTO the child: mapped keys only, taint carried, declared
  // inputs enforced. The rules live in `boundary.ts` because they are the
  // same for any node that delegates to something opaque.
  const fail: BoundaryFailure = (direction, key, detail) => {
    throw new SubgraphInterfaceError(node.id, config.subgraph_id, direction, key, detail);
  };

  const { memory: childMemory, taint: childTaint } = mapInbound(stateView, config.input_mapping);
  validateInbound(childGraph.inputs, childMemory, fail);

  const remainingBudget = ctx.state.max_token_budget
    ? ctx.state.max_token_budget - ctx.state.total_tokens_used
    : undefined;

  // Propagate the parent's REMAINING USD budget so the child enforces cost
  // limits too — without this the child ran with no `budget_usd` and could
  // overspend unbounded (the parent's BudgetMonitor short-circuits on an
  // undefined budget). The parent additionally re-accounts the child's total
  // cost on return (see the returned `token_usage.costUsd`).
  const remainingCostBudget = ctx.state.budget_usd !== undefined
    ? Math.max(0, ctx.state.budget_usd - ctx.state.total_cost_usd)
    : undefined;

  const childState: WorkflowState = {
    state_schema_version: 2,
    workflow_id: config.subgraph_id,
    run_id: uuidv4(),
    created_at: new Date(),
    updated_at: new Date(),
    goal: stateView.goal,
    constraints: stateView.constraints,
    status: 'pending',
    current_node: undefined,
    iteration_count: 0,
    retry_count: 0,
    max_retries: 3,
    last_error: undefined,
    waiting_for: undefined,
    waiting_since: undefined,
    waiting_timeout_at: undefined,
    started_at: undefined,
    max_execution_time_ms: 3_600_000,
    memory: childMemory,
    taint_registry: childTaint,
    lesson_provenance: {},
    policy_approvals: {},
    subgraph_checkpoints: {},
    // Ancestor chain for cycle/depth detection in the child.
    subgraph_stack: [...subgraphStack, ctx.graph.id],
    swarm_handoff_count: 0,
    total_tokens_used: 0,
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_cost_usd: 0,
    node_breakdown: {},
    model_breakdown: {},
    max_token_budget: remainingBudget,
    budget_usd: remainingCostBudget,
    visited_nodes: [],
    max_iterations: config.max_iterations,
    compensation_stack: [],
    supervisor_history: [],
    memory_drops: [],
    _cost_alert_thresholds_fired: [],
  };

  // Lazy import to avoid circular dependency (GraphRunner → subgraph → GraphRunner)
  const { GraphRunner } = await import('../engine/graph-runner.js');

  // The child runs under the parent's guardrails, including the security
  // policy, so a tainted→sensitive action inside the subgraph is gated
  // exactly as it would be in the parent.
  // The child's declared ceiling intersected with this runner's own, so a
  // nested bundle is capped by every enclosing manifest and nesting can
  // never escape a cap.
  const declaredCeiling = ctx.capabilityCeilings?.[config.subgraph_id];
  const childCeiling =
    declaredCeiling && ctx.capabilityCeiling
      ? intersectCeilings(declaredCeiling, ctx.capabilityCeiling)
      : declaredCeiling ?? ctx.capabilityCeiling;

  const childOptions = {
    loadGraphFn: ctx.loadGraphFn,
    onToken: ctx.onToken,
    // Scope the child exactly like the parent: `tools` (the ORIGINAL
    // GraphRunnerOptions array — the child builds its own composition, since
    // the parent's composed resolver would misroute custom-tool sources) and
    // `registry`/`providers` (without them a scoped run's subgraphs would
    // resolve agents from the PROCESS-GLOBAL factory — cross-tenant risk).
    tools: ctx.tools,
    registry: ctx.registry,
    providers: ctx.providers,
    ...(childCeiling ? { capabilityCeiling: childCeiling } : {}),
    ...(ctx.capabilityCeilings ? { capabilityCeilings: ctx.capabilityCeilings } : {}),
    modelResolver: ctx.modelResolver,
    contextCompressor: ctx.contextCompressor,
    memoryRetriever: ctx.memoryRetriever,
    securityPolicy: ctx.securityPolicy,
    memoryWriter: ctx.memoryWriter,
    a2aRegistry: ctx.a2aRegistry,
    a2aClient: ctx.a2aClient,
    factSanitizer: ctx.factSanitizer,
    fitnessFunction: ctx.fitnessFunction,
    ...(ctx.rateLimiter ? { rateLimiter: ctx.rateLimiter } : {}),
    ...(ctx.logger ? { logger: ctx.logger } : {}),
    // The child's execution recorded inline in the parent's log as `child_*`
    // events under this node's namespace. Compaction stays off: the wrapper
    // no-ops it anyway, and the child must never think it manages a log.
    ...(ctx.recordChildEvent
      ? { eventLog: childEventLogWriter(ctx.recordChildEvent, node.id), compactionInterval: 0 }
      : {}),
  };

  // A prior run of this node paused its child for human approval and
  // stashed the child checkpoint in `state.subgraph_checkpoints`. On resume,
  // rehydrate it and forward the human decision rather than restarting the
  // child. On the wire the stash travels as a `_subgraph_resume_<node>` key
  // inside `memory_updates`, which the reducer routes to the field.
  const resumeKey = `_subgraph_resume_${node.id}`;
  const stashed = ctx.state.subgraph_checkpoints?.[node.id];

  // The child runs on its own GraphRunner, so its `workflow.run` span is a
  // separate root unless something links them. This span is that link, and
  // it carries the attributes needed to find a child run from the parent:
  // which graph, which run id, and whether this continued a paused one.
  const finalChildState: WorkflowState = await withSpan(tracer, 'subgraph.run', async (span) => {
    span.setAttribute('subgraph.id', config.subgraph_id);
    span.setAttribute('subgraph.resumed', Boolean(stashed));
    span.setAttribute('subgraph.depth', subgraphStack.length);

    if (stashed) {
      const resumedChild = reviveChildState(stashed);
      span.setAttribute('subgraph.child_run_id', resumedChild.run_id);
      const childRunner = new GraphRunner(childGraph, resumedChild, childOptions);
      childRunner.applyHumanResponse({
        decision: ctx.state.memory.human_decision as 'approved' | 'rejected' | 'edited',
        data: ctx.state.memory.human_response,
      });
      return childRunner.run();
    }

    span.setAttribute('subgraph.child_run_id', childState.run_id);
    const childRunner = new GraphRunner(childGraph, childState, childOptions);
    return childRunner.run();
  });

  // The child paused for a nested approval (tainted → sensitive action). Surface
  // it as a PARENT pause and stash the child checkpoint so resume continues it.
  if (finalChildState.status === 'waiting') {
    const childPending = (finalChildState.memory._pending_approval ?? {}) as Record<string, unknown>;
    logger.info('subgraph_paused_for_approval', { node_id: node.id, subgraph_id: config.subgraph_id });
    return {
      id: uuidv4(),
      idempotency_key: `${nodeIdempotencyKey(node, ctx, attempt)}:wait`,
      type: 'request_human_input',
      payload: {
        waiting_for: 'human_approval',
        pending_approval: { ...childPending, subgraph_node_id: node.id },
        memory_updates: { [resumeKey]: finalChildState },
      },
      metadata: { node_id: node.id, timestamp: new Date(), attempt },
    };
  }

  // A non-completed child (e.g. a rejected nested approval cancelled it) means
  // the nested action was declined — fail the parent node closed.
  if (finalChildState.status !== 'completed') {
    throw new SubgraphIncompleteError(node.id, config.subgraph_id, finalChildState.status);
  }

  // Crossing back OUT: same rules, same module.
  const outputUpdates = mapOutbound(
    finalChildState.memory,
    finalChildState.taint_registry ?? {},
    config.output_mapping,
    childGraph.outputs,
    fail,
  );
  // Clear the resume stash now the child has completed.
  if (stashed) outputUpdates[resumeKey] = undefined;

  // Propagate child compensation stack to parent with namespaced IDs
  const childCompensation = finalChildState.compensation_stack;
  const compensationEntries = childCompensation.length > 0
    ? childCompensation.map(entry => ({
      action_id: `subgraph:${node.id}:${entry.action_id}`,
      compensation_action: entry.compensation_action,
    }))
    : undefined;

  if (compensationEntries) {
    logger.info('subgraph_compensation_propagated', {
      node_id: node.id,
      entries: compensationEntries.length,
    });
  }

  return {
    id: uuidv4(),
    idempotency_key: nodeIdempotencyKey(node, ctx, attempt),
    type: 'update_memory',
    payload: { updates: outputUpdates },
    compensation_entries: compensationEntries,
    metadata: {
      node_id: node.id,
      timestamp: new Date(),
      attempt,
      // Report the child's full token breakdown AND its already-summed cost so
      // the parent rolls both into its own budgets. `costUsd` is authoritative
      // here (the child spanned potentially many models); the parent uses it
      // directly rather than recomputing from tokens.
      token_usage: {
        totalTokens: finalChildState.total_tokens_used,
        inputTokens: finalChildState.total_input_tokens,
        outputTokens: finalChildState.total_output_tokens,
        costUsd: finalChildState.total_cost_usd,
      },
    },
  };
}
