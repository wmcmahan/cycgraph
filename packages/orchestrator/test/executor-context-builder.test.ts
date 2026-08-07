/**
 * Unit tests for buildExecutorContext (runner/executor-context-builder.ts).
 *
 * Exercises the context bag's streaming callbacks, budget closures, and the
 * rate-limiter-wrapped LLM deps in isolation from the runner.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';

vi.mock('../src/agent/agent-executor/executor.js', () => ({
  executeAgent: vi.fn(async () => 'agent-result'),
}));

vi.mock('../src/agent/supervisor-executor/executor.js', () => ({
  executeSupervisor: vi.fn(async () => 'supervisor-result'),
}));

vi.mock('../src/agent/evaluator-executor/executor.js', () => ({
  evaluateQualityExecutor: vi.fn(async () => 'evaluator-result'),
}));

vi.mock('../src/agent/extractor-executor/executor.js', () => ({
  extractFactsExecutor: vi.fn(async () => 'extract-result'),
}));

vi.mock('../src/agent/agent-factory/index.js', () => ({
  agentFactory: { loadAgent: vi.fn(async () => 'loaded-agent') },
}));

vi.mock('../src/runner/fallback-tool-resolver.js', () => ({
  resolveBuiltinsOnly: vi.fn(async () => ({ builtin: {} })),
}));

import { buildExecutorContext } from '../src/runner/executor-context-builder.js';
import type { ExecutorContextRunner } from '../src/runner/executor-context-builder.js';
import { executeAgent } from '../src/agent/agent-executor/executor.js';
import { executeSupervisor } from '../src/agent/supervisor-executor/executor.js';
import { evaluateQualityExecutor } from '../src/agent/evaluator-executor/executor.js';
import { resolveBuiltinsOnly } from '../src/runner/fallback-tool-resolver.js';
import { createTestState } from './helpers/factories.js';
import { makeNode, createSimpleGraph } from './helpers/factories.js';
import type { WorkflowState } from '../src/types/state.js';

interface FakeRunner extends ExecutorContextRunner {
  emitted: Array<{ event: string; payload: unknown }>;
}

function makeRunner(overrides: Partial<ExecutorContextRunner> = {}, state?: WorkflowState): FakeRunner {
  const emitted: Array<{ event: string; payload: unknown }> = [];
  const listeners: Record<string, number> = {};

  const runner: FakeRunner = {
    graph: createSimpleGraph(),
    state: state ?? createTestState({ run_id: uuidv4() }),
    isStreaming: false,
    tokenChannel: [],
    tokenNotify: undefined,
    abortSignal: new AbortController().signal,
    emit(event: string, payload: unknown) {
      emitted.push({ event, payload });
      return true;
    },
    listenerCount(event: string | symbol) {
      return listeners[event as string] ?? 0;
    },
    agentFactory: { loadAgent: vi.fn(async () => 'loaded-agent') } as never,
    emitted,
    ...overrides,
  };

  return runner;
}

describe('buildExecutorContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('onToken', () => {
    it('is undefined when nothing requests streaming', () => {
      const ctx = buildExecutorContext(makeRunner());

      expect(ctx.onToken).toBeUndefined();
    });

    it('is defined when isStreaming is true', () => {
      const ctx = buildExecutorContext(makeRunner({ isStreaming: true }));

      expect(ctx.onToken).toBeInstanceOf(Function);
    });

    it('is defined when an onToken callback is supplied', () => {
      const ctx = buildExecutorContext(makeRunner({ onToken: vi.fn() }));

      expect(ctx.onToken).toBeInstanceOf(Function);
    });

    it('emits agent:token_delta and invokes the runner callback', () => {
      const onToken = vi.fn();
      const runner = makeRunner({ onToken });
      const ctx = buildExecutorContext(runner);

      ctx.onToken!('hi', 'node-1');

      expect(runner.emitted).toEqual([
        { event: 'agent:token_delta', payload: { run_id: runner.state.run_id, node_id: 'node-1', token: 'hi' } },
      ]);
      expect(onToken).toHaveBeenCalledWith('hi', 'node-1');
    });

    it('pushes to the token channel and notifies when streaming', () => {
      const tokenNotify = vi.fn();
      const runner = makeRunner({ isStreaming: true, tokenNotify });
      const ctx = buildExecutorContext(runner);

      ctx.onToken!('tok', 'node-1');

      expect(runner.tokenChannel).toHaveLength(1);
      expect(runner.tokenChannel[0]).toMatchObject({ type: 'agent:token_delta', token: 'tok', node_id: 'node-1' });
      expect(tokenNotify).toHaveBeenCalledOnce();
    });

    it('does not touch the token channel when not streaming', () => {
      const runner = makeRunner({ onToken: vi.fn() });
      const ctx = buildExecutorContext(runner);

      ctx.onToken!('tok', 'node-1');

      expect(runner.tokenChannel).toHaveLength(0);
    });
  });

  describe('onToolCall', () => {
    it('emits tool:call_start with the event fields', () => {
      const runner = makeRunner();
      const ctx = buildExecutorContext(runner);

      ctx.onToolCall({ toolName: 'search', toolCallId: 'call-1', args: { q: 'x' } }, 'node-1');

      expect(runner.emitted[0].event).toBe('tool:call_start');
      expect(runner.emitted[0].payload).toMatchObject({
        type: 'tool:call_start',
        tool_name: 'search',
        tool_call_id: 'call-1',
        args: { q: 'x' },
        node_id: 'node-1',
      });
    });

    it('pushes to the token channel when streaming', () => {
      const tokenNotify = vi.fn();
      const runner = makeRunner({ isStreaming: true, tokenNotify });
      const ctx = buildExecutorContext(runner);

      ctx.onToolCall({ toolName: 'search', toolCallId: 'call-1', args: {} }, 'node-1');

      expect(runner.tokenChannel).toHaveLength(1);
      expect(tokenNotify).toHaveBeenCalledOnce();
    });
  });

  describe('onToolCallComplete', () => {
    it('emits tool:call_finish including the error field when present', () => {
      const runner = makeRunner();
      const ctx = buildExecutorContext(runner);

      ctx.onToolCallComplete(
        { toolName: 'search', toolCallId: 'call-1', durationMs: 12, success: false, error: 'boom' },
        'node-1',
      );

      expect(runner.emitted[0].event).toBe('tool:call_finish');
      expect(runner.emitted[0].payload).toMatchObject({
        type: 'tool:call_finish',
        duration_ms: 12,
        success: false,
        error: 'boom',
      });
    });

    it('omits the error field on success and pushes to a streaming channel', () => {
      const tokenNotify = vi.fn();
      const runner = makeRunner({ isStreaming: true, tokenNotify });
      const ctx = buildExecutorContext(runner);

      ctx.onToolCallComplete(
        { toolName: 'search', toolCallId: 'call-1', durationMs: 5, success: true },
        'node-1',
      );

      expect(runner.emitted[0].payload).not.toHaveProperty('error');
      expect(runner.tokenChannel).toHaveLength(1);
      expect(tokenNotify).toHaveBeenCalledOnce();
    });
  });

  describe('onContextCompressed', () => {
    it('emits context:compressed with the metric fields', () => {
      const tokenNotify = vi.fn();
      const runner = makeRunner({ isStreaming: true, tokenNotify });
      const ctx = buildExecutorContext(runner);

      ctx.onContextCompressed(
        { tokensIn: 100, tokensOut: 40, reductionPercent: 60, durationMs: 7 },
        'node-1',
      );

      expect(runner.emitted[0].event).toBe('context:compressed');
      expect(runner.emitted[0].payload).toMatchObject({
        tokens_in: 100,
        tokens_out: 40,
        reduction_percent: 60,
        duration_ms: 7,
      });
      expect(runner.tokenChannel).toHaveLength(1);
      expect(tokenNotify).toHaveBeenCalledOnce();
    });

    it('emits without touching the token channel when not streaming', () => {
      const runner = makeRunner();
      const ctx = buildExecutorContext(runner);

      ctx.onContextCompressed(
        { tokensIn: 100, tokensOut: 40, reductionPercent: 60, durationMs: 7 },
        'node-1',
      );

      expect(runner.emitted[0].event).toBe('context:compressed');
      expect(runner.tokenChannel).toHaveLength(0);
    });
  });

  describe('onModelResolved', () => {
    it('maps the preferred reason to the tier', () => {
      const runner = makeRunner();
      const ctx = buildExecutorContext(runner);

      ctx.onModelResolved(
        {
          agentId: 'a1',
          originalModel: 'm-orig',
          resolution: { reason: 'preferred', model: 'm-high', tier: 'high' },
        },
        'node-1',
      );

      expect(runner.emitted[0].payload).toMatchObject({
        type: 'model:resolved',
        agent_id: 'a1',
        reason: 'preferred',
        resolved_model: 'm-high',
        original_model: 'm-orig',
        preference: 'high',
      });
    });

    it('maps budget_downgrade to the original tier', () => {
      const runner = makeRunner();
      const ctx = buildExecutorContext(runner);

      ctx.onModelResolved(
        {
          agentId: 'a1',
          originalModel: 'm-orig',
          resolution: { reason: 'budget_downgrade', model: 'm-mid', original_tier: 'high', resolved_tier: 'medium' },
        },
        'node-1',
      );

      expect(runner.emitted[0].payload).toMatchObject({ reason: 'budget_downgrade', preference: 'high' });
    });

    it('maps budget_critical to the original tier', () => {
      const runner = makeRunner();
      const ctx = buildExecutorContext(runner);

      ctx.onModelResolved(
        {
          agentId: 'a1',
          originalModel: 'm-orig',
          resolution: { reason: 'budget_critical', model: 'm-low', original_tier: 'medium', resolved_tier: 'low' },
        },
        'node-1',
      );

      expect(runner.emitted[0].payload).toMatchObject({ reason: 'budget_critical', preference: 'medium' });
    });

    it('pushes to the token channel when streaming', () => {
      const tokenNotify = vi.fn();
      const runner = makeRunner({ isStreaming: true, tokenNotify });
      const ctx = buildExecutorContext(runner);

      ctx.onModelResolved(
        { agentId: 'a1', originalModel: 'm', resolution: { reason: 'preferred', model: 'm', tier: 'low' } },
        'node-1',
      );

      expect(runner.tokenChannel).toHaveLength(1);
      expect(tokenNotify).toHaveBeenCalledOnce();
    });
  });

  describe('budget closures', () => {
    it('computes remainingBudgetUsd from budget and cost', () => {
      const state = createTestState({ budget_usd: 10, total_cost_usd: 3 });
      const ctx = buildExecutorContext(makeRunner({}, state));

      expect(ctx.remainingBudgetUsd).toBe(7);
    });

    it('leaves remainingBudgetUsd undefined when no budget is set', () => {
      const ctx = buildExecutorContext(makeRunner());

      expect(ctx.remainingBudgetUsd).toBeUndefined();
    });

    it('getRemainingBudgetUsd reads live state at call time', () => {
      const state = createTestState({ budget_usd: 10, total_cost_usd: 2 });
      const runner = makeRunner({}, state);
      const ctx = buildExecutorContext(runner);

      runner.state.total_cost_usd = 8;

      expect(ctx.getRemainingBudgetUsd()).toBe(2);
    });

    it('getRemainingBudgetUsd returns undefined without a budget', () => {
      const ctx = buildExecutorContext(makeRunner());

      expect(ctx.getRemainingBudgetUsd()).toBeUndefined();
    });

    it('clamps a fully-spent budget to zero', () => {
      const state = createTestState({ budget_usd: 5, total_cost_usd: 9 });
      const ctx = buildExecutorContext(makeRunner({}, state));

      expect(ctx.remainingBudgetUsd).toBe(0);
    });

    it('treats a non-positive budget as unbudgeted in both closures', () => {
      const state = createTestState({ budget_usd: -5, total_cost_usd: 1 });
      const ctx = buildExecutorContext(makeRunner({}, state));

      expect(ctx.remainingBudgetUsd).toBeUndefined();
      expect(ctx.getRemainingBudgetUsd()).toBeUndefined();
    });
  });

  describe('createStateView', () => {
    it('slices state for the given node', () => {
      const state = createTestState({ goal: 'do the thing' });
      const ctx = buildExecutorContext(makeRunner({}, state));

      const view = ctx.createStateView(makeNode({ read_keys: ['*'] }));

      expect(view.goal).toBe('do the thing');
    });

    it('derives a read-less supervisor’s view from its managed nodes', () => {
      const graph = {
        ...createSimpleGraph(),
        nodes: [
          makeNode({
            id: 'supervisor',
            type: 'supervisor',
            read_keys: [],
            supervisor_config: { managed_nodes: ['worker'], max_iterations: 5 },
          }),
          makeNode({ id: 'worker', write_keys: ['notes'] }),
        ],
      };
      const state = createTestState({
        memory: { notes: 'worker output', secret: 'unrelated' },
      });
      const ctx = buildExecutorContext(makeRunner({ graph }, state));

      const view = ctx.createStateView(graph.nodes[0]);

      expect(view.memory.notes).toBe('worker output');
      expect(view.memory.secret).toBeUndefined();
    });
  });

  describe('deps without a rate limiter', () => {
    it('wraps executors and injects the run-scoped agent factory', async () => {
      const factory = { loadAgent: vi.fn() } as never;
      const ctx = buildExecutorContext(makeRunner({ agentFactory: factory }));

      await ctx.deps.executeAgent('a1', {} as never, {}, 1, { nodeId: 'n' });

      const opts = (executeAgent as ReturnType<typeof vi.fn>).mock.calls[0][4] as { agentFactory: unknown };
      expect(opts.agentFactory).toBe(factory);
    });

    it('delegates loadAgent to the agent factory', async () => {
      const ctx = buildExecutorContext(makeRunner());

      const result = await ctx.deps.loadAgent('a1');

      expect(result).toBe('loaded-agent');
    });

    it('falls back to resolveBuiltinsOnly when no tool resolver is present', () => {
      const ctx = buildExecutorContext(makeRunner());

      expect(ctx.deps.resolveTools).toBe(resolveBuiltinsOnly);
      expect(ctx.deps.drainTaintEntries).toBeUndefined();
    });

    it('delegates to the tool resolver when one is present', async () => {
      const resolveTools = vi.fn(async () => ({ web: {} }));
      const drainTaintEntries = vi.fn(() => []);
      const toolResolver = { resolveTools, drainTaintEntries } as never;
      const ctx = buildExecutorContext(makeRunner({ toolResolver }));

      await ctx.deps.resolveTools([], 'a1');
      ctx.deps.drainTaintEntries!({});

      expect(resolveTools).toHaveBeenCalledWith([], 'a1');
      expect(drainTaintEntries).toHaveBeenCalledOnce();
    });
  });

  describe('deps with a rate limiter', () => {
    it('awaits the limiter before executeAgent', async () => {
      const calls: string[] = [];
      const rateLimiter = vi.fn(async () => { calls.push('limiter'); });
      (executeAgent as ReturnType<typeof vi.fn>).mockImplementation(async () => { calls.push('agent'); return 'r'; });
      const ctx = buildExecutorContext(makeRunner({ rateLimiter }));

      const result = await ctx.deps.executeAgent('a1', {} as never, {}, 1, { nodeId: 'node-1' });

      expect(result).toBe('r');
      expect(calls).toEqual(['limiter', 'agent']);
      expect(rateLimiter).toHaveBeenCalledWith(
        { agentId: 'a1', kind: 'agent', nodeId: 'node-1' },
        expect.objectContaining({ abortSignal: expect.anything() }),
      );
    });

    it('omits nodeId from the limiter key when not provided', async () => {
      const rateLimiter = vi.fn(async () => {});
      const ctx = buildExecutorContext(makeRunner({ rateLimiter }));

      await ctx.deps.executeAgent('a1', {} as never, {}, 1);

      expect(rateLimiter).toHaveBeenCalledWith({ agentId: 'a1', kind: 'agent' }, expect.anything());
    });

    it('awaits the limiter before executeSupervisor', async () => {
      const rateLimiter = vi.fn(async () => {});
      const ctx = buildExecutorContext(makeRunner({ rateLimiter }));
      const node = makeNode({ id: 'sup', agent_id: 'sup-agent' });

      await ctx.deps.executeSupervisor(node, {} as never, [], 1, {});

      expect(rateLimiter).toHaveBeenCalledWith(
        { agentId: 'sup-agent', kind: 'supervisor', nodeId: 'sup' },
        expect.anything(),
      );
      expect(executeSupervisor).toHaveBeenCalledOnce();
    });

    it('falls back to the node id as agentId for a supervisor without agent_id', async () => {
      const rateLimiter = vi.fn(async () => {});
      const ctx = buildExecutorContext(makeRunner({ rateLimiter }));
      const node = makeNode({ id: 'sup', agent_id: undefined });

      await ctx.deps.executeSupervisor(node, {} as never, [], 1, {});

      expect(rateLimiter).toHaveBeenCalledWith(
        { agentId: 'sup', kind: 'supervisor', nodeId: 'sup' },
        expect.anything(),
      );
    });

    it('awaits the limiter before evaluateQualityExecutor', async () => {
      const rateLimiter = vi.fn(async () => {});
      const ctx = buildExecutorContext(makeRunner({ rateLimiter }));

      await ctx.deps.evaluateQualityExecutor('critic', 'goal', 'data', 'instr');

      expect(rateLimiter).toHaveBeenCalledWith({ agentId: 'critic', kind: 'evaluator' }, expect.anything());
      expect(evaluateQualityExecutor).toHaveBeenCalledWith('critic', 'goal', 'data', 'instr', expect.anything());
    });
  });
});
