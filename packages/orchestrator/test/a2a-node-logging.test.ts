/**
 * Tests for how the `a2a` node (execution/nodes/a2a.ts) logs a thrown
 * delivery: a task still running at the bound versus a transport failure.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../src/observability/logger.js', () => ({ createLogger: () => mockLogger }));

import { executeA2ANode } from '../src/execution/nodes/a2a.js';
import { InMemoryA2AServerRegistry } from '../src/a2a/in-memory-registry.js';
import type { A2AClient } from '../src/a2a/client.js';
import type { NodeExecutorContext } from '../src/execution/nodes/context.js';
import type { GraphNode } from '../src/graph/graph.js';
import type { StateView } from '../src/state/state.js';

class A2ATaskPendingError extends Error {
  readonly retryable = false;

  constructor(public readonly taskId: string) {
    super(`A2A task ${taskId} was still running on the remote when the 5000ms budget ran out`);
    this.name = 'A2ATaskPendingError';
  }
}

function throwingClient(error: Error): A2AClient {
  return {
    runTask: async () => {
      throw error;
    },
    resumeTask: async () => {
      throw error;
    },
  };
}

const node = {
  id: 'research',
  type: 'a2a',
  read_keys: ['topic'],
  write_keys: [],
  requires_compensation: false,
  a2a_config: { server_id: 'research-service', input_mapping: {}, output_mapping: {} },
} as unknown as GraphNode;

const view = {
  workflow_id: '00000000-0000-0000-0000-000000000001',
  run_id: '00000000-0000-0000-0000-000000000002',
  goal: 'research',
  constraints: [],
  memory: {},
} as unknown as StateView;

async function ctxWith(client: A2AClient): Promise<NodeExecutorContext> {
  const registry = new InMemoryA2AServerRegistry();
  await registry.saveServer({
    id: 'research-service',
    name: 'Research Service',
    agentCardUrl: 'https://agents.example.com/.well-known/agent-card.json',
  });
  return {
    state: { iteration_count: 0, memory: {}, subgraph_checkpoints: {} },
    a2aRegistry: registry,
    a2aClient: client,
  } as unknown as NodeExecutorContext;
}

describe('executeA2ANode — thrown delivery logging', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('logs a task still running at the bound as a2a_task_pending with its task id', async () => {
    const error = new A2ATaskPendingError('task-7');

    await expect(executeA2ANode(node, view, 1, await ctxWith(throwingClient(error)))).rejects.toBe(error);

    expect(mockLogger.warn).toHaveBeenCalledWith('a2a_task_pending', {
      node_id: 'research',
      server_id: 'research-service',
      task_id: 'task-7',
      error: error.message,
    });
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  it('logs any other throw as a2a_transport_failed', async () => {
    const error = new Error('connection reset');

    await expect(executeA2ANode(node, view, 1, await ctxWith(throwingClient(error)))).rejects.toBe(error);

    expect(mockLogger.error).toHaveBeenCalledWith('a2a_transport_failed', error, {
      node_id: 'research',
      server_id: 'research-service',
    });
    expect(mockLogger.warn).not.toHaveBeenCalledWith('a2a_task_pending', expect.anything());
  });
});
