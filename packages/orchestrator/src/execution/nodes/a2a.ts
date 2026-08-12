/**
 * A2A Node Executor
 *
 * Delegates a unit of work to a remote agent over the Agent2Agent protocol.
 * Sibling to the subgraph executor: both cross a delegation boundary, and
 * both use `boundary.ts` for the crossing itself, so mapping, taint, and
 * interface enforcement cannot drift between them.
 *
 * What differs is everything in the middle, and the differences are the
 * reason this is its own node type:
 *
 * - **Budget does not propagate.** A2A carries no cost field and we cannot
 *   enforce a token cap on someone else's infrastructure. Remote spend is
 *   unmetered; `max_wait_ms` and the failure policy are the only bounds.
 * - **Capability ceilings do not apply.** We constrain what we send and how
 *   we treat what returns, nothing more.
 * - **Returned data is always tainted.** It came from outside the trust
 *   boundary, so it is marked regardless of what the remote agent claims.
 *
 * The two interrupted states are handled differently on purpose:
 *
 * - `input-required` pauses the RUN for a human, exactly as an approval
 *   node does, and stashes the `taskId` so the answer continues the same
 *   remote task rather than starting a new one.
 * - `auth-required` does not pause. Credentials resolve from named
 *   environment variables, so re-sending the identical value cannot help;
 *   it fails non-retryably with a message naming the server.
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
import { markTainted } from '../../security/taint.js';
import type { TaintRegistry } from '../../state/state.js';

const logger = createLogger('runner.node.a2a');
const tracer = getTracer('orchestrator.a2a');

/**
 * Everything a remote agent returns is external data. Marking it here —
 * rather than trusting a per-artifact hint — is what keeps a downstream
 * taint-gated node gated.
 */
function taintAll(artifacts: A2AArtifact[], serverId: string): TaintRegistry {
  let registry: TaintRegistry = {};
  for (const artifact of artifacts) {
    registry = markTainted(registry, artifact.name, {
      source: 'a2a',
      server_id: serverId,
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

  // The registry is the authorization point: a node may only reach a server
  // whose allowlist admits this graph's agent, when one is declared.
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

  // Crossing OUT to the remote agent. No declared interface to validate
  // against on this side: an Agent Card advertises MIME types, not schemas,
  // so the mapping is the only contract we hold.
  const { memory: input } = mapInbound(stateView, config.input_mapping);

  // Auth first, then trace context when this server is trusted with it.
  // `node.execute.a2a` already exists above us; this span is where the
  // remote-specific attributes live, so latency can be sliced by server and
  // a task can be found by id in a trace view rather than only in logs.
  const timeoutMs = config.max_wait_ms ?? server.task_timeout_ms;
  const client = ctx.a2aClient;
  const endpoint = server.agent_card_url;

  // Auth first, then trace context when this server is trusted with it.
  const headers = server.propagate_trace_context
    ? injectTraceContext(resolveAuthHeaders(server.auth))
    : resolveAuthHeaders(server.auth);

  // A stashed task id means a human already answered this node's question.
  // Continue that task instead of re-issuing the work, which would both
  // duplicate the remote side effect and discard the conversation.
  const resumingTaskId = stashed?.task_id;

  let result: A2ATaskResult;
  try {
    // `node.execute.a2a` already wraps us; this span is where the remote
    // attributes live, so latency can be sliced by server and a task found
    // by id in a trace view rather than only in logs.
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
    // A throw means the task could not be run at all. A task that ran and
    // ended badly comes back as a state, not an exception.
    logger.error('a2a_transport_failed', error as Error, {
      node_id: node.id,
      server_id: config.server_id,
    });
    throw error;
  }

  // The remote agent needs a human. Surface it as a run-level pause and
  // stash the task id, so resuming continues the same remote conversation.
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
          // Marks this as a DELEGATED pause so resume re-enters this node
          // and continues the remote task, instead of routing onward as it
          // would for a local approval gate.
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

  // Crossing back IN. Artifacts arrive keyed by name, which is what
  // `output_mapping` matches on, and all of it is tainted.
  const artifactMemory: Record<string, unknown> = {};
  for (const artifact of result.artifacts) {
    artifactMemory[artifact.name] = artifact.value;
  }

  const updates = mapOutbound(
    artifactMemory,
    taintAll(result.artifacts, config.server_id),
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
