/**
 * Shared Test Setup — canonical mock configurations for orchestrator tests.
 *
 * WARNING: Vitest hoists vi.mock() calls from imported files. If you only
 * need factories (createTestState, makeNode, etc.), import from
 * './factories' instead to avoid triggering mock hoisting.
 *
 * Usage:
 *   import { setupCoreMocks, setupAgentMocks } from './helpers/mock-setup';
 *   setupCoreMocks();
 *   setupAgentMocks();
 *
 * Must be called before any dynamic imports that resolve the mocked modules.
 */

import { vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';

// Re-export pure factories for backward compatibility.
// IMPORTANT: Prefer importing from './factories' directly in new tests
// to avoid triggering vi.mock hoisting from this file.
export { createTestState, makeNode, createSimpleGraph, createLinearGraph } from './factories.js';

// ─── Core Mocks ──────────────────────────────────────────────────────

/**
 * Set up canonical mocks for core infrastructure:
 * `@ai-sdk/openai`, `@ai-sdk/anthropic`, `ai`, `@opentelemetry/api`,
 * logger, and tracing.
 */
export function setupCoreMocks() {
  vi.mock('@ai-sdk/openai', () => ({
    openai: vi.fn((model: string) => ({ provider: 'openai', modelId: model })),
  }));

  vi.mock('@ai-sdk/anthropic', () => ({
    anthropic: vi.fn((model: string) => ({ provider: 'anthropic', modelId: model })),
  }));

  vi.mock('ai', async (importOriginal) => {
    const actual = await importOriginal<typeof import('ai')>();
    return {
      ...actual,
      generateText: vi.fn(),
      streamText: vi.fn(),
    };
  });

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

  vi.mock('../../src/utils/logger.js', () => ({
    createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  }));

  vi.mock('../../src/utils/tracing.js', () => ({
    getTracer: () => ({}),
    withSpan: (_tracer: any, _name: string, fn: (span: any) => any) =>
      fn({ setAttribute: vi.fn() }),
  }));
}

// ─── Agent Mocks ─────────────────────────────────────────────────────

/**
 * Set up canonical mocks for agent runtime modules:
 * agent-executor, supervisor-executor, evaluator, agent-factory.
 *
 * Returns mock references for customization.
 */
export function setupAgentMocks() {
  const mockExecuteAgent = vi.fn(async (agentId: string, _stateView: any, _tools: any, attempt: number) => ({
    id: uuidv4(),
    idempotency_key: uuidv4(),
    type: 'update_memory',
    payload: { updates: { [`${agentId}_result`]: 'Mock agent output' } },
    metadata: { node_id: agentId, agent_id: agentId, timestamp: new Date(), attempt, token_usage: { totalTokens: 25 } },
  }));

  vi.mock('../../src/agent/agent-executor/executor.js', () => ({
    executeAgent: (...args: any[]) => mockExecuteAgent(...args),
  }));

  vi.mock('../../src/agent/supervisor-executor/executor.js', () => ({
    executeSupervisor: vi.fn(),
  }));

  vi.mock('../../src/agent/evaluator-executor/executor.js', () => ({
    evaluateQualityExecutor: vi.fn(),
  }));

  vi.mock('../../src/agent/agent-factory', () => ({
    agentFactory: {
      loadAgent: vi.fn().mockResolvedValue({
        id: 'test-agent', name: 'Test', model: 'claude-sonnet-4-6', provider: 'anthropic',
        system: 'test', temperature: 0.7, maxSteps: 10, tools: [],
        read_keys: ['*'], write_keys: ['*'],
      }),
      getModel: vi.fn().mockReturnValue({}),
    },
  }));

  return { mockExecuteAgent };
}
