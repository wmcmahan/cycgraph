/**
 * Eval Suite Integration Tests
 *
 * Runs the example eval suites (linear-completion, supervisor-routing,
 * hitl-approval) through the eval runner with mocked executors.
 * These validate graph mechanics — no LLM calls required.
 */

import { describe, it, expect, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';


vi.mock('@ai-sdk/openai', () => ({
  openai: vi.fn((model: string) => ({ provider: 'openai', modelId: model })),
}));

vi.mock('@ai-sdk/anthropic', () => ({
  anthropic: vi.fn((model: string) => ({ provider: 'anthropic', modelId: model })),
}));

vi.mock('ai', () => ({
  generateObject: vi.fn(),
  streamText: vi.fn(),
}));

vi.mock('@opentelemetry/api', () => ({
  trace: {
    getTracer: () => ({
      startActiveSpan: (_name: string, _opts: any, fn: any) =>
        fn({ setAttribute: vi.fn(), setStatus: vi.fn(), recordException: vi.fn(), end: vi.fn() }),
    }),
  },
  SpanStatusCode: { OK: 0, ERROR: 2 },
  context: {},
}));

vi.mock('../src/agent/agent-executor/executor', () => ({
  executeAgent: vi.fn(async (agentId: string, _stateView: any, _tools: any, attempt: number) => ({
    id: uuidv4(),
    idempotency_key: uuidv4(),
    type: 'update_memory',
    payload: { updates: { [`${agentId}_result`]: 'Mock agent output' } },
    metadata: { node_id: agentId, agent_id: agentId, timestamp: new Date(), attempt },
  })),
}));

vi.mock('../src/agent/supervisor-executor', () => ({
  executeSupervisor: vi.fn(),
}));

vi.mock('../src/agent/agent-factory', () => ({
  agentFactory: {
    loadAgent: vi.fn().mockResolvedValue({
      id: 'test-agent', name: 'Test', model: 'claude-3-5-sonnet', provider: 'anthropic',
      system: 'test', temperature: 0.7, maxSteps: 10, tools: [],
      read_keys: ['*'], write_keys: ['*'],
    }),
    getModel: vi.fn().mockReturnValue({}),
  },
}));

vi.mock('../src/agent/evaluator-executor/executor', () => ({
  evaluateQualityExecutor: vi.fn(),
}));

vi.mock('../src/utils/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../src/utils/tracing', () => ({
  getTracer: () => ({}),
  withSpan: (_tracer: any, _name: string, fn: (span: any) => any) => fn({ setAttribute: vi.fn() }),
}));

import { runEval } from '../src/evals/runner.js';
import { suite as linearSuite } from '../examples/evals/linear-completion.js';
import { suite as supervisorSuite } from '../examples/evals/supervisor-routing.js';
import { suite as hitlSuite } from '../examples/evals/hitl-approval.js';


describe('eval suites', () => {
  it('linear-completion: 2-node tool pipeline completes', async () => {
    const report = await runEval(linearSuite);

    expect(report.suite_name).toBe('Linear Completion');
    expect(report.passed).toBe(1);
    expect(report.failed).toBe(0);
    expect(report.overall_score).toBe(1.0);
    expect(report.cases[0].passed).toBe(true);
  });

  it('supervisor-routing: router dispatches to worker', async () => {
    const report = await runEval(supervisorSuite);

    expect(report.suite_name).toBe('Supervisor Routing');
    expect(report.passed).toBe(1);
    expect(report.failed).toBe(0);
    expect(report.overall_score).toBe(1.0);
    expect(report.cases[0].passed).toBe(true);
  });

  it('hitl-approval: approval gate pauses workflow', async () => {
    const report = await runEval(hitlSuite);

    expect(report.suite_name).toBe('HITL Approval');
    expect(report.passed).toBe(1);
    expect(report.failed).toBe(0);
    expect(report.overall_score).toBe(1.0);
    expect(report.cases[0].passed).toBe(true);
  });
});
