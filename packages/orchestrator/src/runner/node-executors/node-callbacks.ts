/**
 * Shared helper that binds the runner-level streaming callbacks on
 * {@link NodeExecutorContext} (`onToken`, `onToolCall`,
 * `onToolCallComplete`, `onContextCompressed`) to a specific node ID,
 * producing the per-call callback shape consumed by `executeAgent` /
 * `executeSupervisor`.
 *
 * Callers destructure only the callbacks they forward — a fan-out
 * executor that streams tokens but not tool events keeps that choice
 * explicit at the call site.
 *
 * @module runner/node-executors/node-callbacks
 */

import type { ContextCompressionMetrics } from '../../agent/context-compressor.js';
import type { NodeExecutorContext } from './context.js';

/** Node-bound callbacks in the shape `executeAgent` / `executeSupervisor` accept. */
export interface NodeCallbacks {
  /** Token streaming callback bound to the node ID. */
  onToken?: (token: string) => void;
  /** Tool call start callback bound to the node ID. */
  onToolCall?: (event: { toolName: string; toolCallId: string; args: unknown }) => void;
  /** Tool call finish callback bound to the node ID. */
  onToolCallComplete?: (event: { toolName: string; toolCallId: string; durationMs: number; success: boolean; error?: string }) => void;
  /** Context compression callback bound to the node ID (metrics mapped to the runner's event shape). */
  onContextCompressed?: (metrics: ContextCompressionMetrics) => void;
}

/**
 * Bind the context's streaming callbacks to `nodeId`.
 *
 * Each returned callback is `undefined` when the runner did not provide
 * the corresponding context-level callback, so results can be passed
 * straight through to executor options.
 */
export function buildNodeCallbacks(nodeId: string, ctx: NodeExecutorContext): NodeCallbacks {
  return {
    onToken: ctx.onToken ? (token) => ctx.onToken!(token, nodeId) : undefined,
    onToolCall: ctx.onToolCall ? (event) => ctx.onToolCall!(event, nodeId) : undefined,
    onToolCallComplete: ctx.onToolCallComplete
      ? (event) => ctx.onToolCallComplete!(event, nodeId)
      : undefined,
    onContextCompressed: ctx.onContextCompressed
      ? (metrics) => ctx.onContextCompressed!({
          tokensIn: metrics.totalTokensIn,
          tokensOut: metrics.totalTokensOut,
          reductionPercent: metrics.reductionPercent,
          durationMs: metrics.totalDurationMs,
        }, nodeId)
      : undefined,
  };
}
