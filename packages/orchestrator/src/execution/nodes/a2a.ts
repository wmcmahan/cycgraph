/**
 * A2A Node Executor
 *
 * Delegates a step to a remote agent. Boundary crossing (mapping, taint,
 * interface enforcement) is shared with the subgraph executor via
 * `boundary.ts`.
 *
 * Guarantees at this boundary:
 *
 * - Budget and capability ceilings do not extend to the remote agent;
 *   `max_wait_ms` and the failure policy are the only bounds.
 * - Every returned artifact is taint-tracked as external data.
 * - `input-required` pauses the run and stashes the `taskId`; the human
 *   response resumes the same remote task.
 * - `auth-required` fails non-retryably: credentials are named env vars,
 *   so re-sending the identical value cannot succeed.
 *
 * @module execution/nodes/a2a
 */

import type { GraphNode } from '../../graph/graph.js';
import type { Action, StateView } from '../../state/state.js';
import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../../observability/logger.js';
import { getTracer, withSpan, injectTraceContext } from '../../observability/tracing.js';
import { NodeConfigError } from '../errors.js';
import type { NodeExecutorContext } from './context.js';
import { nodeIdempotencyKey } from './idempotency-key.js';
import { A2AInterfaceError, A2ATaskFailedError } from './errors.js';
import { mapInbound, mapOutbound, type BoundaryFailure } from './boundary.js';
import { resolveAuthHeaders } from '../../a2a/schema.js';
import type { A2AArtifact, A2ATaskResult } from '../../a2a/client.js';
import { markTainted, valueBytes } from '../../security/taint.js';
import type { TaintRegistry } from '../../state/state.js';

const logger = createLogger('runner.node.a2a');
const tracer = getTracer('orchestrator.a2a');

/** Taint every returned artifact as external data, keyed by artifact name. */
function taintAll(artifacts: A2AArtifact[], serverId: string, nodeId: string): TaintRegistry {
  let registry: TaintRegistry = {};
  for (const artifact of artifacts) {
    registry = markTainted(registry, artifact.name, {
      source: 'a2a',
      server_id: serverId,
      node_id: nodeId,
      bytes: valueBytes(artifact.value),
      created_at: new Date().toISOString(),
    });
  }
  return registry;
}

/**
 * Execute an `a2a` node.
 *
 * @throws {NodeConfigError} When config, registry, client, or server is missing.
 * @throws {A2AInterfaceError} When a returned value violates a declared schema.
 * @throws {A2ATaskFailedError} When the task did not complete.
 */
export async function executeA2ANode(
  node: GraphNode,
  stateView: StateView,
  _attempt: number,
  ctx: NodeExecutorContext,
): Promise<Action> {
  const config = node.a2a_config;
  if (!config) {
    throw new NodeConfigError(node.id, 'a2a', 'a2a_config');
  }
  if (!ctx.a2aRegistry) {
    throw new NodeConfigError(node.id, 'a2a', 'a2aRegistry');
  }
  if (!ctx.a2aClient) {
    throw new NodeConfigError(node.id, 'a2a', 'a2aClient');
  }

  const resumeKey = `_subgraph_resume_${node.id}`;
  const stashed = ctx.state.subgraph_checkpoints?.[node.id] as { task_id?: string } | undefined;

  const server = await ctx.a2aRegistry.loadServer(config.server_id);
  if (!server) {
    throw new NodeConfigError(node.id, 'a2a', `a2a server "${config.server_id}"`);
  }

  // Server allowlist: only listed agents may use this server.
  if (server.allowed_agents && node.agent_id && !server.allowed_agents.includes(node.agent_id)) {
    throw new NodeConfigError(
      node.id,
      'a2a',
      `agent "${node.agent_id}" permitted to use a2a server "${config.server_id}"`,
    );
  }

  logger.info('a2a_executing', {
    node_id: node.id,
    server_id: config.server_id,
    ...(config.skill_id ? { skill_id: config.skill_id } : {}),
  });

  const fail: BoundaryFailure = (direction, key, detail) => {
    throw new A2AInterfaceError(node.id, config.server_id, direction, key, detail);
  };

  // An Agent Card carries no schemas, so the mapping is the only outbound contract.
  const { memory: input } = mapInbound(stateView, config.input_mapping);

  const timeoutMs = config.max_wait_ms ?? server.task_timeout_ms;
  const client = ctx.a2aClient;
  const endpoint = server.agent_card_url;

  // Trace context is attached only for servers that opted in.
  const headers = server.propagate_trace_context
    ? injectTraceContext(resolveAuthHeaders(server.auth))
    : resolveAuthHeaders(server.auth);

  // A stashed task id resumes that remote task instead of re-issuing the work.
  const resumingTaskId = stashed?.task_id;

  let result: A2ATaskResult;
  try {
    // Inner span carrying the remote-call attributes; `node.execute.a2a` wraps above.
    result = await withSpan(tracer, 'a2a.task', async (span) => {
      span.setAttribute('a2a.server_id', config.server_id);
      span.setAttribute('a2a.resumed', Boolean(resumingTaskId));
      span.setAttribute('a2a.trace_propagated', server.propagate_trace_context);
      if (config.skill_id) span.setAttribute('a2a.skill_id', config.skill_id);

      const taskResult = resumingTaskId
        ? await client.resumeTask({
          agentCardUrl: endpoint,
          headers,
          taskId: resumingTaskId,
          response: ctx.state.memory.human_response,
          timeoutMs,
          ...(ctx.abortSignal ? { abortSignal: ctx.abortSignal } : {}),
        })
        : await client.runTask({
          agentCardUrl: endpoint,
          headers,
          input,
          ...(config.skill_id ? { skillId: config.skill_id } : {}),
          timeoutMs,
          ...(ctx.abortSignal ? { abortSignal: ctx.abortSignal } : {}),
        });

      span.setAttribute('a2a.task_id', taskResult.taskId);
      span.setAttribute('a2a.state', taskResult.state);
      return taskResult;
    });
  } catch (error) {
    // A throw is a transport failure; a task that ran and ended badly returns as a state.
    logger.error('a2a_transport_failed', error as Error, {
      node_id: node.id,
      server_id: config.server_id,
    });
    throw error;
  }

  // Surface the remote question as a run-level pause.
  if (result.state === 'input-required') {
    logger.info('a2a_paused_for_input', {
      node_id: node.id,
      server_id: config.server_id,
      task_id: result.taskId,
    });
    return {
      id: uuidv4(),
      idempotency_key: `${nodeIdempotencyKey(node, ctx, _attempt)}:wait`,
      type: 'request_human_input',
      payload: {
        waiting_for: 'human_approval',
        pending_approval: {
          node_id: node.id,
          // Marks a delegated pause: resume re-enters this node rather than routing onward.
          a2a_node_id: node.id,
          prompt_message: result.message ?? `Remote agent "${config.server_id}" requires input.`,
          a2a_server_id: config.server_id,
          a2a_task_id: result.taskId,
        },
        memory_updates: { [resumeKey]: { task_id: result.taskId } },
      },
      metadata: { node_id: node.id, timestamp: new Date(), attempt: _attempt },
    };
  }

  if (result.state !== 'completed') {
    logger.warn('a2a_task_not_completed', {
      node_id: node.id,
      server_id: config.server_id,
      task_id: result.taskId,
      state: result.state,
    });
    throw new A2ATaskFailedError(node.id, config.server_id, result.state, result.taskId, result.message);
  }

  // Artifacts are keyed by name; `output_mapping` matches on it.
  const artifactMemory: Record<string, unknown> = {};
  for (const artifact of result.artifacts) {
    artifactMemory[artifact.name] = artifact.value;
  }

  const updates = mapOutbound(
    artifactMemory,
    taintAll(result.artifacts, config.server_id, node.id),
    config.output_mapping,
    undefined,
    fail,
  );

  // Clear the resume stash now the remote task has finished.
  if (stashed) updates[resumeKey] = undefined;

  logger.info('a2a_complete', {
    node_id: node.id,
    server_id: config.server_id,
    task_id: result.taskId,
    artifacts: result.artifacts.length,
    keys_written: Object.keys(updates).filter((k) => !k.startsWith('_')),
  });

  return {
    id: uuidv4(),
    idempotency_key: nodeIdempotencyKey(node, ctx, _attempt),
    type: 'update_memory',
    payload: { updates },
    metadata: {
      node_id: node.id,
      timestamp: new Date(),
      attempt: _attempt,
    },
  };
}
