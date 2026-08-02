/**
 * Tests for runner/observer-middleware: the deterministic health checks
 * (token burn, iteration budget, stall detection) and the optional
 * post-run diagnostic agent.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { generateText, mockLogger, resolveModel } = vi.hoisted(() => ({
  generateText: vi.fn(),
  resolveModel: vi.fn(() => ({})),
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('ai', () => ({ generateText }));
vi.mock('../src/agent/provider-registry.js', () => ({
  createProviderRegistry: () => ({ resolveModel }),
}));
vi.mock('../src/utils/logger.js', () => ({ createLogger: () => mockLogger }));

import {
  createObserverMiddleware,
  type ObserverFinding,
  type DiagnosticAgentOptions,
} from '../src/runner/observer-middleware.js';
import type { Action, WorkflowState } from '../src/types/state.js';
import type { MiddlewareContext } from '../src/runner/middleware.js';

function makeAction(overrides: Partial<Action> & { metadata?: Partial<Action['metadata']> } = {}): Action {
  const metadata = {
    node_id: 'test-node',
    timestamp: new Date(),
    attempt: 1,
    ...overrides.metadata,
  };
  return {
    id: crypto.randomUUID(),
    type: 'update_memory',
    payload: { updates: {} },
    idempotency_key: 'idem-key',
    ...overrides,
    metadata,
  } as Action;
}

function makeState(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return {
    workflow_id: crypto.randomUUID(),
    run_id: crypto.randomUUID(),
    goal: 'test',
    status: 'running',
    current_node: 'test-node',
    visited_nodes: [],
    iteration_count: 0,
    max_iterations: 50,
    total_tokens_used: 0,
    memory: {},
    constraints: [],
    compensation_stack: [],
    supervisor_history: [],
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  } as WorkflowState;
}

function makeCtx(): MiddlewareContext {
  return {
    node: { id: 'test-node', type: 'agent', read_keys: ['*'], write_keys: ['*'], requires_compensation: false },
    state: makeState(),
    graph: {
      id: crypto.randomUUID(),
      name: 'test',
      description: '',
      nodes: [{ id: 'discovery', type: 'agent', agent_id: 'agent-1', read_keys: ['*'], write_keys: ['*'], requires_compensation: false }],
      edges: [],
      start_node: 'discovery',
      end_nodes: ['discovery'],
    },
    iteration: 0,
  };
}

function delegation(delegatedTo: string, reasoning: string, iteration: number) {
  return { supervisor_id: 'sup', delegated_to: delegatedTo, reasoning, iteration, timestamp: new Date() };
}

describe('createObserverMiddleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('token burn detection', () => {
    it('fires when an agent uses over-threshold tokens with no memory updates', async () => {
      const findings: ObserverFinding[] = [];
      const mw = createObserverMiddleware({ tokenBurnThreshold: 5_000, onFinding: (f) => findings.push(f) });

      const action = makeAction({
        payload: { updates: { _taint_registry: {} } },
        metadata: { node_id: 'discovery', agent_id: 'agent-1', token_usage: { totalTokens: 8_000 } },
      });
      await mw.afterReduce!(makeCtx(), action, makeState());

      expect(findings).toHaveLength(1);
      expect(findings[0].severity).toBe('warning');
      expect(findings[0].category).toBe('token_burn');
      expect(findings[0].context.node_id).toBe('discovery');
      expect(findings[0].context.total_tokens).toBe(8_000);
    });

    it('fires when the update_memory payload has no updates field at all', async () => {
      const findings: ObserverFinding[] = [];
      const mw = createObserverMiddleware({ tokenBurnThreshold: 5_000, onFinding: (f) => findings.push(f) });

      const action = makeAction({
        payload: {},
        metadata: { node_id: 'discovery', token_usage: { totalTokens: 8_000 } },
      });
      await mw.afterReduce!(makeCtx(), action, makeState());

      expect(findings).toHaveLength(1);
      expect(findings[0].category).toBe('token_burn');
    });

    it('does not fire when the agent saves meaningful memory updates', async () => {
      const findings: ObserverFinding[] = [];
      const mw = createObserverMiddleware({ tokenBurnThreshold: 5_000, onFinding: (f) => findings.push(f) });

      const action = makeAction({
        payload: { updates: { frameworks: [{ name: 'LangGraph' }] } },
        metadata: { node_id: 'discovery', token_usage: { totalTokens: 8_000 } },
      });
      await mw.afterReduce!(makeCtx(), action, makeState());

      expect(findings).toHaveLength(0);
    });

    it('does not fire when tokens are below threshold', async () => {
      const findings: ObserverFinding[] = [];
      const mw = createObserverMiddleware({ tokenBurnThreshold: 10_000, onFinding: (f) => findings.push(f) });

      const action = makeAction({ metadata: { node_id: 'discovery', token_usage: { totalTokens: 3_000 } } });
      await mw.afterReduce!(makeCtx(), action, makeState());

      expect(findings).toHaveLength(0);
    });

    it('ignores non-update_memory actions', async () => {
      const findings: ObserverFinding[] = [];
      const mw = createObserverMiddleware({ tokenBurnThreshold: 1, onFinding: (f) => findings.push(f) });

      const action = makeAction({
        type: 'handoff',
        payload: { target_node: 'next' },
        metadata: { node_id: 'supervisor', token_usage: { totalTokens: 50_000 } },
      });
      await mw.afterReduce!(makeCtx(), action, makeState());

      expect(findings).toHaveLength(0);
    });
  });

  describe('iteration budget detection', () => {
    it('fires a warning at 70% then a critical at 90%, once each', async () => {
      const findings: ObserverFinding[] = [];
      const mw = createObserverMiddleware({ iterationWarnRatio: 0.7, iterationAlertRatio: 0.9, onFinding: (f) => findings.push(f) });
      const action = makeAction();

      await mw.afterReduce!(makeCtx(), action, makeState({ iteration_count: 35, max_iterations: 50 }));
      expect(findings).toHaveLength(1);
      expect(findings[0].severity).toBe('warning');

      await mw.afterReduce!(makeCtx(), action, makeState({ iteration_count: 40, max_iterations: 50 }));
      expect(findings).toHaveLength(1);

      await mw.afterReduce!(makeCtx(), action, makeState({ iteration_count: 45, max_iterations: 50 }));
      expect(findings).toHaveLength(2);
      expect(findings[1].severity).toBe('critical');
      expect(findings[1].category).toBe('iteration_budget');
    });

    it('does not fire below the warn ratio', async () => {
      const findings: ObserverFinding[] = [];
      const mw = createObserverMiddleware({ onFinding: (f) => findings.push(f) });

      await mw.afterReduce!(makeCtx(), makeAction(), makeState({ iteration_count: 5, max_iterations: 50 }));

      expect(findings).toHaveLength(0);
    });

    it('does not fire when max_iterations is zero', async () => {
      const findings: ObserverFinding[] = [];
      const mw = createObserverMiddleware({ onFinding: (f) => findings.push(f) });

      await mw.afterReduce!(makeCtx(), makeAction(), makeState({ iteration_count: 100, max_iterations: 0 }));

      expect(findings).toHaveLength(0);
    });
  });

  describe('stall detection', () => {
    it('fires when the supervisor delegates to the same node N times consecutively', async () => {
      const findings: ObserverFinding[] = [];
      const mw = createObserverMiddleware({ stallThreshold: 3, onFinding: (f) => findings.push(f) });

      const state = makeState({
        supervisor_history: [
          delegation('discovery', 'first', 1),
          delegation('discovery', 'retry', 2),
          delegation('discovery', 'retry again', 3),
        ],
      });
      await mw.afterReduce!(makeCtx(), makeAction(), state);

      expect(findings).toHaveLength(1);
      expect(findings[0].severity).toBe('warning');
      expect(findings[0].category).toBe('stall_detected');
      expect(findings[0].context.delegated_to).toBe('discovery');
      expect(findings[0].context.consecutive_count).toBe(3);
    });

    it('does not fire with mixed delegations', async () => {
      const findings: ObserverFinding[] = [];
      const mw = createObserverMiddleware({ stallThreshold: 3, onFinding: (f) => findings.push(f) });

      const state = makeState({
        supervisor_history: [
          delegation('discovery', 'a', 1),
          delegation('mapper', 'b', 2),
          delegation('discovery', 'c', 3),
        ],
      });
      await mw.afterReduce!(makeCtx(), makeAction(), state);

      expect(findings).toHaveLength(0);
    });

    it('does not fire when history is shorter than the threshold', async () => {
      const findings: ObserverFinding[] = [];
      const mw = createObserverMiddleware({ stallThreshold: 3, onFinding: (f) => findings.push(f) });

      const state = makeState({
        supervisor_history: [delegation('discovery', 'first', 1), delegation('discovery', 'retry', 2)],
      });
      await mw.afterReduce!(makeCtx(), makeAction(), state);

      expect(findings).toHaveLength(0);
    });

    it('only inspects the tail of history', async () => {
      const findings: ObserverFinding[] = [];
      const mw = createObserverMiddleware({ stallThreshold: 3, onFinding: (f) => findings.push(f) });

      const state = makeState({
        supervisor_history: [
          delegation('discovery', 'a', 1),
          delegation('discovery', 'b', 2),
          delegation('discovery', 'c', 3),
          delegation('mapper', 'd', 4),
          delegation('synthesizer', 'e', 5),
          delegation('evaluator', 'f', 6),
        ],
      });
      await mw.afterReduce!(makeCtx(), makeAction(), state);

      expect(findings).toHaveLength(0);
    });
  });

  describe('combined checks', () => {
    it('emits multiple findings from a single afterReduce call', async () => {
      const findings: ObserverFinding[] = [];
      const mw = createObserverMiddleware({
        tokenBurnThreshold: 5_000,
        iterationWarnRatio: 0.7,
        stallThreshold: 2,
        onFinding: (f) => findings.push(f),
      });

      const action = makeAction({ metadata: { node_id: 'discovery', token_usage: { totalTokens: 20_000 } } });
      const state = makeState({
        iteration_count: 40,
        max_iterations: 50,
        supervisor_history: [delegation('discovery', 'a', 1), delegation('discovery', 'b', 2)],
      });
      await mw.afterReduce!(makeCtx(), action, state);

      expect(findings).toHaveLength(3);
      expect(findings.map((f) => f.category).sort()).toEqual(['iteration_budget', 'stall_detected', 'token_burn']);
    });

    it('builds a working middleware with default options and no other hooks', () => {
      const mw = createObserverMiddleware();

      expect(mw.afterReduce).toBeDefined();
      expect(mw.beforeNodeExecute).toBeUndefined();
      expect(mw.afterNodeExecute).toBeUndefined();
      expect(mw.beforeAdvance).toBeUndefined();
    });
  });

  describe('diagnostic agent', () => {
    function makeDiagnosticConfig(overrides: Partial<DiagnosticAgentOptions> = {}) {
      let resolveDone: () => void;
      const done = new Promise<void>((resolve) => { resolveDone = resolve; });
      const reports: string[] = [];
      const config: DiagnosticAgentOptions = {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        onDiagnostic: (report) => { reports.push(report); resolveDone(); },
        ...overrides,
      };
      return { config, done, reports };
    }

    it('runs on a terminal state when findings exist and forwards the report', async () => {
      generateText.mockResolvedValueOnce({ text: 'diagnostic report', usage: { inputTokens: 10, outputTokens: 20 } });
      const { config, done, reports } = makeDiagnosticConfig();
      const mw = createObserverMiddleware({ tokenBurnThreshold: 5_000, diagnosticAgent: config });

      const action = makeAction({ metadata: { node_id: 'discovery', token_usage: { totalTokens: 8_000 } } });
      await mw.afterReduce!(makeCtx(), action, makeState({ status: 'completed' }));
      await done;

      expect(generateText).toHaveBeenCalledTimes(1);
      expect(reports).toEqual(['diagnostic report']);
    });

    it('runs on a clean terminal run when alwaysRun is true', async () => {
      generateText.mockResolvedValueOnce({ text: 'clean health check', usage: {} });
      const { config, done, reports } = makeDiagnosticConfig({ alwaysRun: true });
      const mw = createObserverMiddleware({ diagnosticAgent: config });

      await mw.afterReduce!(makeCtx(), makeAction(), makeState({ status: 'completed' }));
      await done;

      expect(reports).toEqual(['clean health check']);
    });

    it('does not run on a clean terminal run when alwaysRun is false', async () => {
      const { config } = makeDiagnosticConfig();
      const mw = createObserverMiddleware({ diagnosticAgent: config });

      await mw.afterReduce!(makeCtx(), makeAction(), makeState({ status: 'completed' }));

      expect(generateText).not.toHaveBeenCalled();
    });

    it('does not run before the workflow reaches a terminal state', async () => {
      generateText.mockResolvedValueOnce({ text: 'x', usage: {} });
      const { config } = makeDiagnosticConfig({ alwaysRun: true });
      const mw = createObserverMiddleware({ diagnosticAgent: config });

      await mw.afterReduce!(makeCtx(), makeAction(), makeState({ status: 'running' }));

      expect(generateText).not.toHaveBeenCalled();
    });

    it('runs at most once across repeated terminal reductions', async () => {
      generateText.mockResolvedValue({ text: 'once', usage: {} });
      const { config, done } = makeDiagnosticConfig({ alwaysRun: true });
      const mw = createObserverMiddleware({ diagnosticAgent: config });

      await mw.afterReduce!(makeCtx(), makeAction(), makeState({ status: 'completed' }));
      await done;
      await mw.afterReduce!(makeCtx(), makeAction(), makeState({ status: 'completed' }));

      expect(generateText).toHaveBeenCalledTimes(1);
    });

    it('logs an error and does not throw when the diagnostic agent fails', async () => {
      generateText.mockRejectedValueOnce(new Error('LLM down'));
      const { config } = makeDiagnosticConfig({ alwaysRun: true });
      const mw = createObserverMiddleware({ diagnosticAgent: config });

      await mw.afterReduce!(makeCtx(), makeAction(), makeState({ status: 'completed' }));

      await vi.waitFor(() => {
        expect(mockLogger.error).toHaveBeenCalledWith('observer.diagnostic_agent_error', { error: 'LLM down' });
      });
    });
  });
});
