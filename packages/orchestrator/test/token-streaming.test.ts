import { describe, it, expect, beforeEach, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';

// ─── Mocks ───────────────────────────────────────────────────

vi.mock('ai', () => ({
  streamText: vi.fn(),
  tool: vi.fn((def: any) => def),
  jsonSchema: vi.fn((def: any) => def),
  stepCountIs: vi.fn((n: number) => ({ type: 'stepCount', count: n })),
}));

vi.mock('../src/agent/agent-factory/index', () => ({
  agentFactory: {
    loadAgent: vi.fn(),
    getModel: vi.fn(() => ({ provider: 'anthropic', modelId: 'claude-sonnet-4-6' })),
  },
}));

vi.mock('../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../src/utils/tracing.js', () => ({
  getTracer: () => ({}),
  withSpan: (_tracer: unknown, _name: string, fn: (span: any) => any) =>
    fn({ setAttribute: vi.fn() }),
}));

import { streamText } from 'ai';
import { agentFactory } from '../src/agent/agent-factory/index.js';
import { executeAgent } from '../src/agent/agent-executor/executor.js';
import type { StateView } from '../src/types/state.js';

// ─── Helpers ─────────────────────────────────────────────────

function makeStateView(overrides: Partial<StateView> = {}): StateView {
  return {
    workflow_id: uuidv4(),
    run_id: uuidv4(),
    goal: 'Test streaming',
    constraints: [],
    memory: {},
    ...overrides,
  };
}

function makeAgentConfig(overrides: Record<string, unknown> = {}) {
  return {
    id: 'stream-agent',
    name: 'Stream Agent',
    description: 'Agent for streaming tests',
    model: 'claude-sonnet-4-6',
    provider: 'anthropic' as const,
    system: 'You are a test agent.',
    temperature: 0.7,
    maxSteps: 10,
    tools: [],
    read_keys: ['*'],
    write_keys: ['*'],
    ...overrides,
  };
}

/**
 * Create an async iterable from an array of string deltas.
 * Simulates the AI SDK textStream behavior.
 */
async function* asyncIterableFrom(deltas: string[]): AsyncIterable<string> {
  for (const delta of deltas) {
    yield delta;
  }
}

function mockStreamTextResult(deltas: string[]) {
  const fullText = deltas.join('');
  return {
    text: Promise.resolve(fullText),
    textStream: asyncIterableFrom(deltas),
    usage: Promise.resolve({ inputTokens: 50, outputTokens: 25, totalTokens: 75 }),
    totalUsage: Promise.resolve({ inputTokens: 50, outputTokens: 25, totalTokens: 75 }),
    steps: Promise.resolve([{ toolCalls: [], toolResults: [] }]),
    toolCalls: Promise.resolve([]),
    toolResults: Promise.resolve([]),
  };
}

// ─── Tests ───────────────────────────────────────────────────

describe('Token Streaming', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (agentFactory.loadAgent as any).mockResolvedValue(makeAgentConfig());
  });

  describe('executeAgent onToken callback', () => {
    it('fires onToken for each text delta', async () => {
      const deltas = ['Hello', ' world', '!'];
      (streamText as any).mockReturnValue(mockStreamTextResult(deltas));

      const received: string[] = [];
      const onToken = (token: string) => received.push(token);

      await executeAgent('stream-agent', makeStateView(), {}, 1, { onToken });

      expect(received).toEqual(['Hello', ' world', '!']);
    });

    it('assembles full text from deltas correctly', async () => {
      const deltas = ['The ', 'answer ', 'is 42'];
      (streamText as any).mockReturnValue(mockStreamTextResult(deltas));

      const onToken = vi.fn();
      const action = await executeAgent('stream-agent', makeStateView(), {}, 1, { onToken });

      // Full text should be assembled from deltas
      const updates = action.payload.updates as Record<string, unknown>;
      expect(updates.agent_response).toBe('The answer is 42');
    });

    it('does not error when onToken is not provided', async () => {
      const deltas = ['No', ' callback'];
      (streamText as any).mockReturnValue(mockStreamTextResult(deltas));

      // Should use the await result.text path without error
      const action = await executeAgent('stream-agent', makeStateView(), {}, 1);
      expect(action.type).toBe('update_memory');
      const updates = action.payload.updates as Record<string, unknown>;
      expect(updates.agent_response).toBe('No callback');
    });

    it('handles empty stream', async () => {
      (streamText as any).mockReturnValue(mockStreamTextResult([]));

      const received: string[] = [];
      const action = await executeAgent('stream-agent', makeStateView(), {}, 1, {
        onToken: (t) => received.push(t),
      });

      expect(received).toEqual([]);
      expect(action.type).toBe('update_memory');
    });

    it('tracks token usage even with streaming', async () => {
      const deltas = ['token', ' streaming'];
      (streamText as any).mockReturnValue(mockStreamTextResult(deltas));

      const action = await executeAgent('stream-agent', makeStateView(), {}, 1, {
        onToken: vi.fn(),
      });

      const metadata = action.metadata as any;
      expect(metadata.token_usage).toEqual({
        inputTokens: 50,
        outputTokens: 25,
        totalTokens: 75,
      });
    });
  });

  describe('GraphRunner agent:token_delta events', () => {
    // These tests use mocks at a higher level to verify the GraphRunner
    // event emission through the full executor chain.

    // We import GraphRunner after mocking its dependencies.
    // The mocks are already set up above for agent-factory and ai SDK.

    it('emits agent:token_delta events during graph run', async () => {
      // Mock dependencies for GraphRunner
      vi.doMock('@ai-sdk/openai', () => ({
        openai: vi.fn((model: string) => ({ provider: 'openai', modelId: model })),
      }));
      vi.doMock('@ai-sdk/anthropic', () => ({
        anthropic: vi.fn((model: string) => ({ provider: 'anthropic', modelId: model })),
      }));
      vi.doMock('@opentelemetry/api', () => ({
        trace: {
          getTracer: () => ({
            startActiveSpan: (_name: string, _opts: any, fn: any) =>
              fn({ setAttribute: vi.fn(), setStatus: vi.fn(), recordException: vi.fn(), end: vi.fn() }),
          }),
        },
        SpanStatusCode: { OK: 0, ERROR: 2 },
        context: {},
      }));

      // Mock executeAgent to call onToken if provided
      vi.doMock('../src/agent/agent-executor/executor', () => ({
        executeAgent: vi.fn(async (agentId: string, _sv: any, _tools: any, attempt: number, options?: any) => {
          // Simulate streaming by calling onToken
          if (options?.onToken) {
            options.onToken('Hello');
            options.onToken(' from ');
            options.onToken(agentId);
          }
          return {
            id: uuidv4(),
            idempotency_key: uuidv4(),
            type: 'update_memory',
            payload: { updates: { [`${agentId}_result`]: `Hello from ${agentId}` } },
            metadata: { node_id: agentId, agent_id: agentId, timestamp: new Date(), attempt },
          };
        }),
      }));

      vi.doMock('../src/agent/supervisor-executor/executor', () => ({
        executeSupervisor: vi.fn(),
      }));

            vi.doMock('../src/agent/agent-factory/index', () => ({
        agentFactory: {
          loadAgent: vi.fn().mockResolvedValue({
            id: 'test-agent', name: 'Test', model: 'claude-sonnet-4-6', provider: 'anthropic',
            system: 'test', temperature: 0.7, maxSteps: 10, tools: [],
            read_keys: ['*'], write_keys: ['*'],
          }),
          getModel: vi.fn().mockReturnValue({}),
        },
      }));

      // Import GraphRunner fresh with the doMock overrides
      const { GraphRunner } = await import('../src/runner/graph-runner.js');

      const graph = {
        id: uuidv4(),
        name: 'Streaming Test',
        description: 'Test token streaming',
        start_node: 'agent-1',
        end_nodes: ['agent-1'],
        nodes: [{
          id: 'agent-1', type: 'agent' as const, agent_id: 'researcher',
          read_keys: ['*'], write_keys: ['*'],
          failure_policy: { max_retries: 1, backoff_strategy: 'fixed' as const, initial_backoff_ms: 100, max_backoff_ms: 100 },
          requires_compensation: false,
        }],
        edges: [],
      };

      const state = {
        workflow_id: graph.id,
        run_id: uuidv4(),
        created_at: new Date(),
        updated_at: new Date(),
        goal: 'Test',
        constraints: [],
        status: 'pending' as const,
        iteration_count: 0,
        retry_count: 0,
        max_retries: 3,
        memory: {},
        visited_nodes: [],
        max_iterations: 50,
        compensation_stack: [],
        max_execution_time_ms: 3600000,
        supervisor_history: [],
        total_tokens_used: 0,
      };

      const tokenEvents: Array<{ run_id: string; node_id: string; token: string }> = [];
      const onToken = vi.fn((token: string, nodeId: string) => {
        // Just record that onToken was called
      });

      const runner = new GraphRunner(graph, state, { onToken });

      runner.on('agent:token_delta', (data: any) => {
        tokenEvents.push(data);
      });

      await runner.run();

      // Verify token delta events were emitted
      expect(tokenEvents.length).toBe(3);
      expect(tokenEvents[0]).toEqual({
        run_id: state.run_id,
        node_id: 'agent-1',
        token: 'Hello',
      });
      expect(tokenEvents[1]).toEqual({
        run_id: state.run_id,
        node_id: 'agent-1',
        token: ' from ',
      });
      expect(tokenEvents[2]).toEqual({
        run_id: state.run_id,
        node_id: 'agent-1',
        token: 'researcher',
      });
    });
  });
});
