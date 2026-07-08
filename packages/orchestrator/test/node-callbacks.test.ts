/**
 * Unit tests for `buildNodeCallbacks` — the shared helper that binds the
 * runner-level streaming callbacks (`onToken`, `onToolCall`,
 * `onToolCallComplete`, `onContextCompressed`) to a specific node ID for
 * `executeAgent` / `executeSupervisor` calls.
 */

import { describe, it, expect, vi } from 'vitest';
import { buildNodeCallbacks } from '../src/runner/node-executors/node-callbacks.js';
import type { NodeExecutorContext } from '../src/runner/node-executors/context.js';

function makeCtx(overrides: Partial<NodeExecutorContext> = {}): NodeExecutorContext {
  return {
    state: {} as never,
    graph: {} as never,
    createStateView: () => ({} as never),
    deps: {} as never,
    ...overrides,
  };
}

describe('buildNodeCallbacks', () => {
  it('returns undefined for every callback when the context provides none', () => {
    const callbacks = buildNodeCallbacks('node-1', makeCtx());
    expect(callbacks.onToken).toBeUndefined();
    expect(callbacks.onToolCall).toBeUndefined();
    expect(callbacks.onToolCallComplete).toBeUndefined();
    expect(callbacks.onContextCompressed).toBeUndefined();
  });

  it('binds onToken to the node ID', () => {
    const onToken = vi.fn();
    const { onToken: bound } = buildNodeCallbacks('node-1', makeCtx({ onToken }));
    bound!('hello');
    expect(onToken).toHaveBeenCalledWith('hello', 'node-1');
  });

  it('binds onToolCall and onToolCallComplete to the node ID', () => {
    const onToolCall = vi.fn();
    const onToolCallComplete = vi.fn();
    const callbacks = buildNodeCallbacks('node-2', makeCtx({ onToolCall, onToolCallComplete }));

    const startEvent = { toolName: 'search', toolCallId: 'tc-1', args: { q: 'x' } };
    callbacks.onToolCall!(startEvent);
    expect(onToolCall).toHaveBeenCalledWith(startEvent, 'node-2');

    const finishEvent = { toolName: 'search', toolCallId: 'tc-1', durationMs: 12, success: true };
    callbacks.onToolCallComplete!(finishEvent);
    expect(onToolCallComplete).toHaveBeenCalledWith(finishEvent, 'node-2');
  });

  it('maps compression metrics to the runner event shape and binds the node ID', () => {
    const onContextCompressed = vi.fn();
    const { onContextCompressed: bound } = buildNodeCallbacks(
      'node-3',
      makeCtx({ onContextCompressed }),
    );
    bound!({
      totalTokensIn: 1000,
      totalTokensOut: 400,
      reductionPercent: 60,
      totalDurationMs: 25,
      stages: [],
    });
    expect(onContextCompressed).toHaveBeenCalledWith(
      { tokensIn: 1000, tokensOut: 400, reductionPercent: 60, durationMs: 25 },
      'node-3',
    );
  });
});
