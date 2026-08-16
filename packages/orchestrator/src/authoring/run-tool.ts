/**
 * runTool() — a deterministic step that calls one tool
 *
 * No model is involved. Where an agent's tool call needs an LLM to decide to
 * make it and may skip it, this node always runs, costs no tokens, and writes
 * the result to `${id}_result`.
 *
 * The node's `reads` slice is passed to the tool as its argument object, so
 * `reads` is the argument list, not just a permission.
 *
 * Named `runTool` rather than `toolCall` because `toolCalls` elsewhere in the
 * engine means model-emitted calls, which is the opposite of this.
 *
 * @module authoring/run-tool
 */

import { withOutputs, toolOutputs, type ToolOutputs } from './outputs.js';
import { NODE_BRAND, type NodeCommon, type NodeValue } from './node.js';

/**
 * Authoring spec for {@link runTool}. The inherited `reads` slice is passed to
 * the tool as its argument object, so it is the argument list, not merely a
 * permission.
 */
export type RunToolSpec = NodeCommon;

/**
 * Author a `tool` node.
 *
 * @param toolId - Id of a built-in, defined, or MCP tool.
 * @param spec - Placement and the argument slice.
 */
export function runTool(toolId: string, spec: RunToolSpec): NodeValue & ToolOutputs {
  return withOutputs(
    { ...spec, type: 'tool' as const, toolId, [NODE_BRAND]: true as const } as NodeValue,
    toolOutputs(spec.id),
  );
}
