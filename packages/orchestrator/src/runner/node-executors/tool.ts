/**
 * Tool Node Executor
 *
 * Executes a standalone tool (MCP or built-in) and writes the result
 * to workflow memory. If the tool returns tainted data (external MCP),
 * the taint registry is updated accordingly.
 *
 * @module runner/node-executors/tool
 */

import type { GraphNode } from '../../types/graph.js';
import type { Action, StateView, TaintMetadata } from '../../types/state.js';
import type { TaintedToolResultShape } from './context.js';
import { nodeIdempotencyKey } from './idempotency-key.js';
import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../../utils/logger.js';
import { NodeConfigError } from '../errors.js';
import type { NodeExecutorContext } from './context.js';

const logger = createLogger('runner.node.tool');

/**
 * Execute a tool node.
 *
 * Writes the result to `memory[<node_id>_result]`. If the tool
 * returns a {@link TaintedToolResultShape}, the taint registry
 * is updated to track the external data provenance.
 *
 * @param node - Tool node with `tool_id`.
 * @param stateView - Filtered state view (memory passed as tool args).
 * @param attempt - Retry attempt number.
 * @param ctx - Executor context.
 * @returns `update_memory` action with the tool result.
 * @throws If `tool_id` is missing.
 */
export async function executeToolNode(
  node: GraphNode,
  stateView: StateView,
  attempt: number,
  ctx: NodeExecutorContext,
): Promise<Action> {
  const toolId = node.tool_id;
  if (!toolId) {
    throw new NodeConfigError(node.id, 'tool', 'tool_id');
  }

  logger.info('tool_node_executing', { tool_id: toolId, node_id: node.id });

  // Resolve tool sources from node config, then find the named tool
  const toolSources = node.tools ?? [];
  const resolvedTools = await ctx.deps.resolveTools(toolSources, node.agent_id);
  const toolDef = resolvedTools[toolId] as { execute?: (args: Record<string, unknown>) => Promise<unknown> } | undefined;
  if (!toolDef?.execute) {
    logger.warn('tool_not_resolvable', {
      tool_id: toolId,
      node_id: node.id,
      hint: 'Add tool sources to the node or configure a ToolResolver',
    });
    throw new NodeConfigError(node.id, 'tool', `resolvable tool "${toolId}" (no tool sources configured or tool not found in resolved sources)`);
  }
  const raw = await toolDef.execute(stateView.memory);

  const resultKey = `${node.id}_result`;

  // Two taint shapes are possible:
  // 1. The result itself carries { result, taint } (explicit wrapper).
  // 2. The MCPConnectionManager accumulated taint during execute() — drain
  //    it from this resolution's collector. This is the common case for real
  //    MCP tools; without it, standalone tool nodes wrote external data to
  //    memory UNTAINTED, defeating downstream taint-aware routing/warnings.
  const isTaintedResult = raw && typeof raw === 'object' && 'taint' in raw && 'result' in raw;
  const resultValue = isTaintedResult ? (raw as TaintedToolResultShape).result : raw;

  const updates: Record<string, unknown> = { [resultKey]: resultValue };

  let taint: TaintMetadata | undefined;
  if (isTaintedResult) {
    taint = (raw as TaintedToolResultShape).taint as unknown as TaintMetadata;
  } else {
    const drained = ctx.deps.drainTaintEntries?.(resolvedTools);
    if (drained && drained.size > 0) {
      const [, firstEntry] = drained.entries().next().value as [string, TaintMetadata];
      taint = {
        source: 'mcp_tool',
        tool_name: [...new Set([...drained.values()].map((e) => e.tool_name).filter(Boolean))].join(',') || toolId,
        server_id: firstEntry.server_id,
        created_at: new Date().toISOString(),
      };
    }
  }

  if (taint) {
    const registry = ctx.deps.getTaintRegistry(ctx.state.memory);
    registry[resultKey] = taint;
    updates['_taint_registry'] = registry;
  }

  return {
    id: uuidv4(),
    idempotency_key: nodeIdempotencyKey(node, ctx, attempt),
    type: 'update_memory',
    payload: { updates },
    metadata: {
      node_id: node.id,
      timestamp: new Date(),
      attempt,
    },
  };
}
