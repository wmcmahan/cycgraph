/**
 * Run-path test for inline tool references: a facade run() with a tool()
 * value referenced directly from a node must deliver that tool — resolved
 * and executable — to the agent executor through a REAL GraphRunner and the
 * real composed tool resolution. Guards the whole pipeline: graph()
 * collapse → stash → run() auto-wiring → runner preflight → resolution.
 */

import { describe, it, expect, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import type { StateView } from '../src/types/state.js';

const capturedToolsets: Record<string, unknown>[] = [];

vi.mock('../src/agent/agent-executor/executor.js', () => ({
  executeAgent: vi.fn(async (
    agentId: string,
    _view: StateView,
    tools: Record<string, unknown>,
    attempt: number,
    options?: { nodeId?: string; idempotencyKey?: string },
  ) => {
    capturedToolsets.push(tools);
    return {
      id: uuidv4(),
      idempotency_key: options?.idempotencyKey ?? uuidv4(),
      type: 'update_memory',
      payload: { updates: { out: 'done' } },
      metadata: { node_id: options?.nodeId ?? agentId, agent_id: agentId, timestamp: new Date(), attempt },
    };
  }),
}));

vi.mock('../src/utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { agent, node, graph, run } from '../src/authoring/index.js';
import { tool } from '../src/tools/define-tool.js';

describe('inline tool references on the run path', () => {
  it('delivers an inline tool() to the agent executor resolved and executable', async () => {
    const orders: string[] = [];
    const lookupOrder = tool({
      name: 'lookup_order',
      description: 'Fetch an order by id',
      parameters: z.object({ orderId: z.string() }),
      execute: ({ orderId }) => {
        orders.push(orderId);
        return { orderId, status: 'shipped' };
      },
    });
    const worker = node({
      id: 'worker',
      agent: agent({ model: 'claude-sonnet-4-6', instructions: 'Look up orders.' }),
      tools: [lookupOrder],
      writes: 'out',
    });
    const g = graph({ name: 'inline-runpath', nodes: [worker], edges: [] });

    const memory = await run(g, { goal: 'look up order 42' });

    expect(memory.out).toBe('done');
    expect(capturedToolsets).toHaveLength(1);
    const resolved = capturedToolsets[0].lookup_order as {
      execute: (args: unknown) => Promise<unknown>;
    };
    expect(resolved).toBeDefined();

    const result = await resolved.execute({ orderId: '42' });

    expect(result).toEqual({ orderId: '42', status: 'shipped' });
    expect(orders).toEqual(['42']);
  });
});
