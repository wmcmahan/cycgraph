/**
 * Supervisor Executor
 *
 * Executes a supervisor node that uses an LLM to dynamically route work
 * between managed sub-nodes. Uses the AI SDK's structured output to
 * produce type-safe routing decisions.
 *
 * Flow:
 * 1. Validate supervisor config and check max iteration guard
 * 2. Load the supervisor's agent config and model
 * 3. Build context-aware routing prompt (with injection guards)
 * 4. Get structured routing decision via `generateText` + `Output.object`
 * 5. Validate the decision against the `managed_nodes` allowlist
 * 6. Return a `handoff` or `set_status` action
 *
 * @module supervisor-executor/executor
 */

import { generateText, Output } from 'ai';
import { z } from 'zod';
import { agentFactory } from '../agent-factory/index.js';
import type { GraphNode } from '../../types/graph.js';
import type { StateView, Action, WorkflowState } from '../../types/state.js';
import { createLogger } from '../../utils/logger.js';
import { getTracer, withSpan } from '../../utils/tracing.js';
import { v4 as uuidv4 } from 'uuid';
import { SUPERVISOR_DONE } from './constants.js';
import { buildSupervisorSystemPrompt } from './prompt.js';
import { AgentExecutionError } from '../agent-executor/errors.js';
import { classifyRetryable } from '../agent-executor/error-classification.js';
import { SupervisorConfigError, SupervisorRoutingError } from './errors.js';

const logger = createLogger('agent.supervisor');
const tracer = getTracer('orchestrator.supervisor');

/**
 * Zod schema for the structured routing decision returned by the LLM.
 *
 * Used with `Output.object` to enforce type-safe extraction — no
 * free-form text parsing required.
 */
export const SupervisorDecisionSchema = z.object({
  /** Node ID to delegate to, or `'__done__'` to signal completion. */
  next_node: z.string(),
  /** Reasoning for why this node was chosen. */
  reasoning: z.string(),
});

/** Inferred type of a supervisor routing decision. */
export type SupervisorDecision = z.infer<typeof SupervisorDecisionSchema>;

/**
 * Execute a supervisor node to produce a routing decision.
 *
 * @param node - The supervisor graph node to execute.
 * @param stateView - The current workflow state scoped to this supervisor.
 * @param supervisorHistory - The accumulated routing decision history.
 * @param attempt - The current attempt number (1-based, increments on retry).
 * @param options - Optional execution configuration.
 * @param options.abortSignal - External cancellation signal.
 * @returns A `handoff` action (delegate to a worker) or a `set_status` action (workflow complete).
 * @throws {SupervisorConfigError} If the node is missing `supervisor_config`.
 * @throws {SupervisorRoutingError} If the LLM routes to a node not in `managed_nodes`.
 */
export async function executeSupervisor(
  node: GraphNode,
  stateView: StateView,
  supervisorHistory: WorkflowState['supervisor_history'],
  attempt: number,
  options?: {
    abortSignal?: AbortSignal;
    model_override?: string;
    contextCompressor?: import('../context-compressor.js').ContextCompressor;
    onContextCompressed?: (metrics: import('../context-compressor.js').ContextCompressionMetrics) => void;
    /** Memory retriever for injecting relevant facts into the routing prompt. */
    memoryRetriever?: import('../memory-retriever.js').MemoryRetriever;
    /** Per-node retrieval directive (paired with `memoryRetriever`). */
    memory_query?: {
      text?: string;
      entityIds?: string[];
      tags?: string[];
      maxFacts?: number;
    };
  },
): Promise<Action> {
  return withSpan(tracer, 'supervisor.route', async (span) => {
    span.setAttribute('supervisor.id', node.id);
    span.setAttribute('supervisor.attempt', attempt);

    const startTime = Date.now();
    const config = node.supervisor_config;

    if (!config) {
      throw new SupervisorConfigError(node.id, 'supervisor_config is required for supervisor nodes');
    }

    // Max iterations guard — prevents infinite routing loops
    const supervisorIterations = supervisorHistory.filter(h => h.supervisor_id === node.id).length;
    if (supervisorIterations >= config.max_iterations) {
      logger.warn('max_iterations_reached', {
        supervisor_id: node.id,
        iterations: supervisorIterations,
        max: config.max_iterations,
      });

      return createCompletionAction(node.id, attempt, Date.now() - startTime, 'Max supervisor iterations reached', supervisorIterations);
    }

    // Resolve agent ID: supervisor_config.agent_id takes precedence, falls back to node.agent_id
    const supervisorAgentId = config.agent_id ?? node.agent_id;
    if (!supervisorAgentId) {
      throw new SupervisorConfigError(node.id, 'supervisor node requires agent_id on the node or in supervisor_config');
    }

    // Load agent config for the supervisor LLM (cached)
    const agentConfig = await agentFactory.loadAgent(supervisorAgentId);
    // Budget-aware model resolution: use override if provided
    const validatedOverride = options?.model_override && typeof options.model_override === 'string' && options.model_override.trim().length > 0
      ? options.model_override
      : undefined;

    if (options?.model_override && !validatedOverride) {
      logger.warn('invalid_model_override', {
        agent_id: supervisorAgentId,
        node_id: node.id,
        model_override: options.model_override,
        fallback_model: agentConfig.model,
      });
    }

    const effectiveConfig = validatedOverride
      ? { ...agentConfig, model: validatedOverride }
      : agentConfig;
    const model = agentFactory.getModel(effectiveConfig);

    // Resolve memory retrieval (best-effort — failures must never block
    // routing; the supervisor still gets the workflow-state memory below).
    const retrievedMemory = await retrieveForSupervisorPrompt(
      options?.memoryRetriever,
      options?.memory_query,
      stateView,
      effectiveConfig.model,
    );

    const systemPrompt = buildSupervisorSystemPrompt(agentConfig.system, config, stateView, supervisorHistory, {
      contextCompressor: options?.contextCompressor,
      model: effectiveConfig.model,
      onCompressed: options?.onContextCompressed,
      retrievedMemory,
    });

    logger.info('routing', {
      supervisor_id: node.id,
      agent_id: supervisorAgentId,
      managed_nodes: config.managed_nodes,
      iteration: supervisorIterations + 1,
    });

    let decision: SupervisorDecision;
    let usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined;
    try {
      const result = await generateText({
        model,
        output: Output.object({ schema: SupervisorDecisionSchema }),
        system: systemPrompt,
        prompt: `Based on the current workflow state, decide which node should execute next. Choose from the available nodes or select '${SUPERVISOR_DONE}' if the goal is fully achieved.`,
        ...(options?.abortSignal ? { abortSignal: options.abortSignal } : {}),
        ...(agentConfig.providerOptions ? { providerOptions: agentConfig.providerOptions } : {}),
      });
      decision = result.output;
      usage = result.usage;
    } catch (error) {
      // Wrap the raw provider error in the typed taxonomy with retriable
      // classification — same path as agent nodes, so the runner's retry
      // loop short-circuits a non-retryable 400 instead of retrying it.
      span.setAttribute('supervisor.error', error instanceof Error ? error.message : String(error));
      throw new AgentExecutionError(supervisorAgentId, error, undefined, classifyRetryable(error));
    }

    const duration = Date.now() - startTime;

    logger.info('decision', {
      supervisor_id: node.id,
      next_node: decision.next_node,
      reasoning: decision.reasoning,
      duration_ms: duration,
      input_tokens: usage?.inputTokens ?? 0,
      output_tokens: usage?.outputTokens ?? 0,
    });

    // Token usage from the routing call. MUST be attached to the returned
    // action — the runner reads action.metadata.token_usage to drive token
    // budgets, cost budgets, per-node budgets, and usage_records. Without it
    // every supervisor iteration's spend is invisible to all budget guards.
    const tokenUsage = {
      inputTokens: usage?.inputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      totalTokens: usage?.totalTokens ?? ((usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0)),
    };

    // Handle completion
    if (decision.next_node === SUPERVISOR_DONE) {
      return createCompletionAction(node.id, attempt, duration, decision.reasoning, supervisorIterations, tokenUsage, effectiveConfig.model);
    }

    // Validate routing against managed_nodes allowlist
    if (!config.managed_nodes.includes(decision.next_node)) {
      throw new SupervisorRoutingError(
        node.id,
        decision.next_node,
        config.managed_nodes,
      );
    }

    span.setAttribute('supervisor.decision', decision.next_node);
    span.setAttribute('supervisor.reasoning', decision.reasoning);
    span.setAttribute('supervisor.iteration', supervisorIterations + 1);
    span.setAttribute('supervisor.input_tokens', usage?.inputTokens ?? 0);
    span.setAttribute('supervisor.output_tokens', usage?.outputTokens ?? 0);

    return createHandoffAction(node, supervisorAgentId, attempt, duration, decision, supervisorIterations, tokenUsage, effectiveConfig.model);
  });
}

/** Token usage breakdown attached to supervisor actions for budget accounting. */
interface SupervisorTokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/**
 * Create a handoff action — supervisor delegates to another node.
 *
 * @param node - The supervisor graph node.
 * @param attempt - Current attempt number.
 * @param duration - Execution duration in milliseconds.
 * @param decision - The LLM's routing decision.
 * @param iteration - Current supervisor iteration count.
 * @returns A `handoff` {@link Action}.
 */
function createHandoffAction(
  node: GraphNode,
  agentId: string,
  attempt: number,
  duration: number,
  decision: SupervisorDecision,
  iteration: number,
  tokenUsage?: SupervisorTokenUsage,
  model?: string,
): Action {
  return {
    id: uuidv4(),
    idempotency_key: `${node.id}:handoff:${iteration}:${attempt}`,
    type: 'handoff',
    payload: {
      node_id: decision.next_node,
      supervisor_id: node.id,
      reasoning: decision.reasoning,
    },
    metadata: {
      node_id: node.id,
      agent_id: agentId,
      timestamp: new Date(),
      attempt,
      duration_ms: duration,
      ...(model ? { model } : {}),
      ...(tokenUsage ? { token_usage: tokenUsage } : {}),
    },
  };
}

/**
 * Create a completion action — supervisor signals the workflow is done.
 *
 * @param supervisorId - The supervisor node ID.
 * @param attempt - Current attempt number.
 * @param duration - Execution duration in milliseconds.
 * @param reasoning - The LLM's reasoning for completion.
 * @param iteration - Current supervisor iteration count.
 * @returns A `set_status` {@link Action} with `status: 'completed'`.
 */
function createCompletionAction(
  supervisorId: string,
  attempt: number,
  duration: number,
  reasoning: string,
  iteration: number,
  tokenUsage?: SupervisorTokenUsage,
  model?: string,
): Action {
  return {
    id: uuidv4(),
    idempotency_key: `${supervisorId}:complete:${iteration}:${attempt}`,
    type: 'set_status',
    payload: {
      status: 'completed',
      supervisor_completion_reason: reasoning,
    },
    metadata: {
      node_id: supervisorId,
      timestamp: new Date(),
      attempt,
      duration_ms: duration,
      ...(model ? { model } : {}),
      ...(tokenUsage ? { token_usage: tokenUsage } : {}),
    },
  };
}

/**
 * Resolve memory for the supervisor's routing prompt. Mirrors
 * `retrieveForPrompt` in agent-executor: best-effort, default-text-to-goal
 * only when no explicit query knob is set.
 */
async function retrieveForSupervisorPrompt(
  retriever: import('../memory-retriever.js').MemoryRetriever | undefined,
  rawQuery:
    | { text?: string; entityIds?: string[]; tags?: string[]; maxFacts?: number }
    | undefined,
  stateView: StateView,
  model: string,
): Promise<import('../memory-retriever.js').MemoryRetrievalResult | null> {
  if (!retriever || !rawQuery) return null;

  const query: { text?: string; entityIds?: string[]; tags?: string[] } = {};
  if (rawQuery.text) query.text = rawQuery.text;
  if (rawQuery.entityIds && rawQuery.entityIds.length > 0) query.entityIds = rawQuery.entityIds;
  if (rawQuery.tags && rawQuery.tags.length > 0) query.tags = rawQuery.tags;

  if (
    query.text === undefined &&
    query.entityIds === undefined &&
    query.tags === undefined
  ) {
    query.text = stateView.goal;
  }

  try {
    return await retriever(query, {
      ...(rawQuery.maxFacts !== undefined ? { maxFacts: rawQuery.maxFacts } : {}),
      model,
    });
  } catch (err) {
    logger.warn('memory_retriever_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
