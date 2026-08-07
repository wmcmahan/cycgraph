/**
 * Run-path test for derived supervisor reads: a REAL GraphRunner.run() must
 * hand the supervisor executor a state view containing its managed nodes'
 * outputs when the supervisor declares no reads. This exercises the
 * node-execution driver's view build — the production path — not the
 * executor-context closure (unit-testing only the closure is exactly what
 * masked the original wiring bug).
 */

import { describe, it, expect, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import type { StateView } from '../src/types/state.js';

const capturedViews: StateView[] = [];

vi.mock('../src/agent/supervisor-executor/executor.js', () => ({
  executeSupervisor: vi.fn(async (node: { id: string }, stateView: StateView, _h: unknown, attempt: number) => {
    capturedViews.push(stateView);
    return {
      id: uuidv4(),
      idempotency_key: `${node.id}:complete:${attempt}`,
      type: 'set_status',
      payload: { status: 'completed' },
      metadata: { node_id: node.id, timestamp: new Date(), attempt },
    };
  }),
}));

vi.mock('../src/utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { GraphRunner } from '../src/runner/graph-runner.js';
import { createGraph } from '../src/types/graph.js';
import { markTainted } from '../src/utils/taint.js';
import type { SecurityPolicy } from '../src/runner/security-policy.js';
import { createTestState } from './helpers/factories.js';

function supervisorOverWorker() {
  return createGraph({
    name: 'derived-reads',
    description: 'grant-less supervisor over one worker',
    nodes: [
      {
        id: 'supervisor',
        type: 'supervisor',
        agentId: uuidv4(),
        supervisorConfig: { managedNodes: ['worker'], maxIterations: 3 },
      },
      { id: 'worker', type: 'agent', agentId: uuidv4(), readKeys: ['goal'], writeKeys: ['notes'] },
    ],
    edges: [
      { source: 'supervisor', target: 'worker' },
      { source: 'worker', target: 'supervisor' },
    ],
    startNode: 'supervisor',
    endNodes: [],
  });
}

describe('derived supervisor reads on the run path', () => {
  it('hands the supervisor a view of its managed nodes’ outputs during a real run', async () => {
    const state = createTestState({
      memory: { notes: 'worker already produced this', secret: 'must stay invisible' },
    });

    const finalState = await new GraphRunner(supervisorOverWorker(), state).run();

    expect(finalState.status).toBe('completed');
    expect(capturedViews.length).toBeGreaterThan(0);
    const view = capturedViews[0];
    expect(view.memory.notes).toBe('worker already produced this');
    expect(view.memory.secret).toBeUndefined();
  });

  it('taint-gates derived supervisor reads through the security policy', async () => {
    const state = createTestState({ memory: { notes: 'from an external tool' } });
    state.taint_registry = markTainted({}, 'notes', {
      source: 'mcp_tool',
      tool_name: 'web_search',
      created_at: new Date().toISOString(),
    });
    const policyCalls: string[][] = [];
    const policy: SecurityPolicy = (input) => {
      policyCalls.push(input.tainted_read_keys);
      return { effect: 'block', sensitivity: 'high', reason: 'no tainted routing' };
    };
    const supervisorCallsBefore = capturedViews.length;

    const finalState = await new GraphRunner(supervisorOverWorker(), state, {
      securityPolicy: policy,
    }).run().catch(() => undefined);

    expect(policyCalls.flat()).toContain('notes');
    expect(capturedViews.length).toBe(supervisorCallsBefore);
    if (finalState) expect(finalState.status).toBe('failed');
  });
});
