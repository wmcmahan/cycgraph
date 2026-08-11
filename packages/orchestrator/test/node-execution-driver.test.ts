/**
 * node-execution-driver.test.ts — the per-node execution pipeline: retry with
 * backoff, circuit-breaker gating, node-vs-workflow timeout arbitration,
 * failed-attempt usage accounting, lifecycle events, and registry dispatch.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NodeExecutionDriver } from '../src/execution/engine/node-execution-driver.js';
import type { NodeExecutionDriverDeps } from '../src/execution/engine/node-execution-driver.js';
import { WorkflowTimeoutError, UnsupportedNodeTypeError } from '../src/execution/errors.js';
import { createStateView } from '../src/state/state-view.js';
import { createTestState, makeNode, createSimpleGraph } from './helpers/factories.js';
import type { GraphNode } from '../src/graph/graph.js';
import type { WorkflowState } from '../src/state/state.js';
import type { NodeExecutorContext } from '../src/execution/nodes/context.js';

vi.mock('../src/observability/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../src/observability/tracing.js', () => ({
  getTracer: () => ({}),
  withSpan: (_t: unknown, _n: string, fn: (s: unknown) => unknown) => fn({ setAttribute: vi.fn() }),
}));

interface Harness {
  driver: NodeExecutionDriver;
  deps: NodeExecutionDriverDeps;
  emit: ReturnType<typeof vi.fn>;
  dispatchInternal: ReturnType<typeof vi.fn>;
  pushPending: ReturnType<typeof vi.fn>;
  abortController: AbortController;
  execute: ReturnType<typeof vi.fn>;
  state: WorkflowState;
}

function makeToolNode(overrides: Partial<GraphNode> = {}): GraphNode {
  return makeNode({
    id: 'tool-node',
    type: 'tool',
    tool_id: 't',
    tools: [],
    failure_policy: { max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 1, max_backoff_ms: 1 },
    ...overrides,
  } as Partial<GraphNode>);
}

function makeHarness(opts: {
  isStreaming?: boolean;
  startTime?: number;
  state?: WorkflowState;
} = {}): Harness {
  const state = opts.state ?? createTestState({ max_execution_time_ms: 3_600_000 });
  const graph = createSimpleGraph();
  const abortController = new AbortController();
  const emit = vi.fn();
  const dispatchInternal = vi.fn();
  const pushPending = vi.fn();
  const execute = vi.fn().mockResolvedValue('tool output');

  const buildExecutorContext = (): NodeExecutorContext => ({
    state,
    graph,
    createStateView: (node: GraphNode) => createStateView(state, node),
    deps: {
      resolveTools: vi.fn().mockResolvedValue({ t: { execute } }),
      drainTaintEntries: vi.fn().mockReturnValue(new Map()),
    } as never,
  } as NodeExecutorContext);

  const deps: NodeExecutionDriverDeps = {
    getGraph: () => graph,
    getState: () => state,
    getStartTime: () => opts.startTime,
    isStreaming: () => opts.isStreaming ?? false,
    getWorkflowAbortController: () => abortController,
    buildExecutorContext,
    dispatchInternal,
    emit,
    pushPending,
  };

  return { driver: new NodeExecutionDriver(deps), deps, emit, dispatchInternal, pushPending, abortController, execute, state };
}

describe('NodeExecutionDriver', () => {
  describe('nodeAbortSignal', () => {
    it('returns the workflow signal when no node controller is active', () => {
      const h = makeHarness();
      expect(h.driver.nodeAbortSignal()).toBe(h.abortController.signal);
    });

    it('returns the already-aborted workflow signal', () => {
      const h = makeHarness();
      h.abortController.abort();
      expect(h.driver.nodeAbortSignal().aborted).toBe(true);
    });

    it('combines the workflow and node signals while a node timeout is armed', async () => {
      const h = makeHarness();
      let combined: AbortSignal | undefined;
      h.execute.mockImplementation(async () => {
        combined = h.driver.nodeAbortSignal();
        return 'ok';
      });
      const node = makeToolNode({
        failure_policy: { max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 1, max_backoff_ms: 1, timeout_ms: 10_000 },
      });

      await h.driver.executeWithTimeout(node);

      expect(combined).toBeDefined();
      expect(combined).not.toBe(h.abortController.signal);
      expect(combined!.aborted).toBe(false);
    });
  });

  describe('successful execution', () => {
    it('emits node:start and node:complete and returns the action in non-streaming mode', async () => {
      const h = makeHarness();

      const action = await h.driver.executeWithTimeout(makeToolNode());

      expect(action.type).toBe('update_memory');
      const events = h.emit.mock.calls.map(c => c[0]);
      expect(events).toContain('node:start');
      expect(events).toContain('node:complete');
    });

    it('does not emit lifecycle events in streaming mode', async () => {
      const h = makeHarness({ isStreaming: true });

      await h.driver.executeWithTimeout(makeToolNode());

      const events = h.emit.mock.calls.map(c => c[0]);
      expect(events).not.toContain('node:start');
      expect(events).not.toContain('node:complete');
    });
  });

  describe('failure handling', () => {
    it('emits node:failed and rethrows when every attempt fails (non-streaming)', async () => {
      const h = makeHarness();
      h.execute.mockRejectedValue(new Error('boom'));

      await expect(h.driver.executeWithTimeout(makeToolNode())).rejects.toThrow('boom');

      expect(h.emit.mock.calls.map(c => c[0])).toContain('node:failed');
    });

    it('does not emit node:failed in streaming mode', async () => {
      const h = makeHarness({ isStreaming: true });
      h.execute.mockRejectedValue(new Error('boom'));

      await expect(h.driver.executeWithTimeout(makeToolNode())).rejects.toThrow('boom');

      expect(h.emit.mock.calls.map(c => c[0])).not.toContain('node:failed');
    });

    it('throws UnsupportedNodeTypeError for a node type with no registered executor', async () => {
      const h = makeHarness();
      const node = makeToolNode({ type: 'not-a-type' as never });

      await expect(h.driver.executeWithTimeout(node)).rejects.toBeInstanceOf(UnsupportedNodeTypeError);
    });

    it('stringifies a non-Error thrown value into the node:failed event', async () => {
      const h = makeHarness();
      h.execute.mockRejectedValue('bare string failure');

      await expect(h.driver.executeWithTimeout(makeToolNode())).rejects.toBe('bare string failure');

      const failed = h.emit.mock.calls.find(c => c[0] === 'node:failed');
      expect(failed?.[1].error).toBe('bare string failure');
    });
  });

  describe('retry', () => {
    it('retries a retryable failure with backoff and succeeds on a later attempt', async () => {
      const h = makeHarness();
      h.execute.mockRejectedValueOnce(new Error('transient')).mockResolvedValueOnce('recovered');
      const node = makeToolNode({
        failure_policy: { max_retries: 2, backoff_strategy: 'fixed', initial_backoff_ms: 1, max_backoff_ms: 1 },
      });

      const action = await h.driver.executeWithTimeout(node);

      expect(action.type).toBe('update_memory');
      expect(h.emit.mock.calls.map(c => c[0])).toContain('node:retry');
    });

    it('pushes a node:retry stream event while streaming', async () => {
      const h = makeHarness({ isStreaming: true });
      h.execute.mockRejectedValueOnce(new Error('transient')).mockResolvedValueOnce('ok');
      const node = makeToolNode({
        failure_policy: { max_retries: 2, backoff_strategy: 'fixed', initial_backoff_ms: 1, max_backoff_ms: 1 },
      });

      await h.driver.executeWithTimeout(node);

      expect(h.pushPending).toHaveBeenCalledWith(expect.objectContaining({ type: 'node:retry' }));
    });

    it('short-circuits without retrying when the error is marked non-retryable', async () => {
      const h = makeHarness();
      const err = Object.assign(new Error('bad request'), { retryable: false });
      h.execute.mockRejectedValue(err);
      const node = makeToolNode({
        failure_policy: { max_retries: 3, backoff_strategy: 'fixed', initial_backoff_ms: 1, max_backoff_ms: 1 },
      });

      await expect(h.driver.executeWithTimeout(node)).rejects.toThrow('bad request');

      expect(h.execute).toHaveBeenCalledTimes(1);
      expect(h.emit.mock.calls.map(c => c[0])).not.toContain('node:retry');
    });
  });

  describe('failed-attempt usage accounting', () => {
    it('tracks tokens, cost, and model usage from an error partialUsage payload', async () => {
      const h = makeHarness();
      const err = Object.assign(new Error('failed mid-call'), {
        partialUsage: { inputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000, model: 'gpt-4o' },
      });
      h.execute.mockRejectedValue(err);

      await expect(h.driver.executeWithTimeout(makeToolNode())).rejects.toThrow('failed mid-call');

      const tracked = h.dispatchInternal.mock.calls.map(c => c[0]);
      expect(tracked).toContain('_track_tokens');
      expect(tracked).toContain('_track_cost');
      expect(tracked).toContain('_track_model_usage');
    });

    it('ignores an error that carries no partial usage', async () => {
      const h = makeHarness();
      h.execute.mockRejectedValue(new Error('plain error'));

      await expect(h.driver.executeWithTimeout(makeToolNode())).rejects.toThrow('plain error');

      expect(h.dispatchInternal).not.toHaveBeenCalled();
    });

    it('tracks only tokens when the model is absent from partial usage', async () => {
      const h = makeHarness();
      const err = Object.assign(new Error('failed'), { partialUsage: { totalTokens: 500 } });
      h.execute.mockRejectedValue(err);

      await expect(h.driver.executeWithTimeout(makeToolNode())).rejects.toThrow('failed');

      const tracked = h.dispatchInternal.mock.calls.map(c => c[0]);
      expect(tracked).toContain('_track_tokens');
      expect(tracked).not.toContain('_track_cost');
      expect(tracked).not.toContain('_track_model_usage');
    });

    it('derives total tokens from input plus output when total is absent', async () => {
      const h = makeHarness();
      const err = Object.assign(new Error('failed'), { partialUsage: { inputTokens: 100, outputTokens: 50 } });
      h.execute.mockRejectedValue(err);

      await expect(h.driver.executeWithTimeout(makeToolNode())).rejects.toThrow('failed');

      const tokensCall = h.dispatchInternal.mock.calls.find(c => c[0] === '_track_tokens');
      expect(tokensCall?.[1]).toMatchObject({ tokens: 150 });
    });

    it('defaults output tokens to zero when only input tokens are reported', async () => {
      const h = makeHarness();
      const err = Object.assign(new Error('failed'), { partialUsage: { inputTokens: 100, model: 'gpt-4o' } });
      h.execute.mockRejectedValue(err);

      await expect(h.driver.executeWithTimeout(makeToolNode())).rejects.toThrow('failed');

      const modelCall = h.dispatchInternal.mock.calls.find(c => c[0] === '_track_model_usage');
      expect(modelCall?.[1]).toMatchObject({ input_tokens: 100, output_tokens: 0 });
    });

    it('defaults input tokens to zero when only output tokens are reported', async () => {
      const h = makeHarness();
      const err = Object.assign(new Error('failed'), { partialUsage: { outputTokens: 50, model: 'gpt-4o' } });
      h.execute.mockRejectedValue(err);

      await expect(h.driver.executeWithTimeout(makeToolNode())).rejects.toThrow('failed');

      const modelCall = h.dispatchInternal.mock.calls.find(c => c[0] === '_track_model_usage');
      expect(modelCall?.[1]).toMatchObject({ input_tokens: 0, output_tokens: 50 });
    });

    it('skips usage accounting entirely when a model reports zero tokens', async () => {
      const h = makeHarness();
      const err = Object.assign(new Error('failed'), { partialUsage: { inputTokens: 0, outputTokens: 0, model: 'gpt-4o' } });
      h.execute.mockRejectedValue(err);

      await expect(h.driver.executeWithTimeout(makeToolNode())).rejects.toThrow('failed');

      expect(h.dispatchInternal).not.toHaveBeenCalled();
    });

    it('records model usage but no cost when the model has no known pricing', async () => {
      const h = makeHarness();
      const err = Object.assign(new Error('failed'), {
        partialUsage: { inputTokens: 100, outputTokens: 20, model: 'unpriced-model' },
      });
      h.execute.mockRejectedValue(err);

      await expect(h.driver.executeWithTimeout(makeToolNode())).rejects.toThrow('failed');

      const tracked = h.dispatchInternal.mock.calls.map(c => c[0]);
      expect(tracked).toContain('_track_model_usage');
      expect(tracked).not.toContain('_track_cost');
    });
  });

  describe('circuit breaker', () => {
    const breakerNode = (overrides: Partial<GraphNode> = {}) => makeToolNode({
      failure_policy: {
        max_retries: 1,
        backoff_strategy: 'fixed',
        initial_backoff_ms: 1,
        max_backoff_ms: 1,
        circuit_breaker: { enabled: true, failure_threshold: 3, reset_timeout_ms: 1000, half_open_max_attempts: 1 },
      },
      ...overrides,
    } as Partial<GraphNode>);

    it('checks and updates the breaker on a successful execution', async () => {
      const h = makeHarness();

      const action = await h.driver.executeWithTimeout(breakerNode());

      expect(action.type).toBe('update_memory');
    });

    it('records a breaker failure when execution throws', async () => {
      const h = makeHarness();
      h.execute.mockRejectedValue(new Error('breaker fail'));

      await expect(h.driver.executeWithTimeout(breakerNode())).rejects.toThrow('breaker fail');
    });
  });

  describe('timeout arbitration', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('throws WorkflowTimeoutError immediately when the deadline is already past', async () => {
      const h = makeHarness({ startTime: Date.now() - 10_000, state: createTestState({ max_execution_time_ms: 1000 }) });

      await expect(h.driver.executeWithTimeout(makeToolNode())).rejects.toBeInstanceOf(WorkflowTimeoutError);
      expect(h.abortController.signal.aborted).toBe(true);
    });

    it('aborts only the node when a node-level timeout fires', async () => {
      const h = makeHarness();
      h.execute.mockReturnValue(new Promise(() => {}));
      const node = makeToolNode({
        failure_policy: { max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 1, max_backoff_ms: 1, timeout_ms: 50 },
      });

      const promise = h.driver.executeWithTimeout(node);
      const assertion = expect(promise).rejects.toThrow(/timeout after 50ms/);
      await vi.advanceTimersByTimeAsync(60);
      await assertion;

      expect(h.abortController.signal.aborted).toBe(false);
    });

    it('picks the node timeout when it is tighter than the remaining workflow budget', async () => {
      const h = makeHarness({ startTime: Date.now(), state: createTestState({ max_execution_time_ms: 10_000 }) });
      h.execute.mockReturnValue(new Promise(() => {}));
      const node = makeToolNode({
        failure_policy: { max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 1, max_backoff_ms: 1, timeout_ms: 50 },
      });

      const promise = h.driver.executeWithTimeout(node);
      const assertion = expect(promise).rejects.toThrow(/timeout after 50ms/);
      await vi.advanceTimersByTimeAsync(60);
      await assertion;

      expect(h.abortController.signal.aborted).toBe(false);
    });

    it('aborts the workflow when the workflow-level timeout is the tighter bound', async () => {
      const h = makeHarness({ startTime: Date.now(), state: createTestState({ max_execution_time_ms: 50 }) });
      h.execute.mockReturnValue(new Promise(() => {}));

      const promise = h.driver.executeWithTimeout(makeToolNode());
      const assertion = expect(promise).rejects.toBeInstanceOf(WorkflowTimeoutError);
      await vi.advanceTimersByTimeAsync(60);
      await assertion;

      expect(h.abortController.signal.aborted).toBe(true);
    });
  });
});
