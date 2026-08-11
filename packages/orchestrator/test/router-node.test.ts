import { describe, it, expect, vi } from 'vitest';
import { executeRouterNode } from '../src/execution/nodes/router.js';
import type { NodeExecutorContext } from '../src/execution/nodes/context.js';
import { makeNode, createTestState, createSimpleGraph } from './helpers/factories.js';

vi.mock('../src/observability/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  }),
}));

function createMockCtx(overrides: Partial<NodeExecutorContext> = {}): NodeExecutorContext {
  return {
    state: createTestState({ iteration_count: 5 }),
    graph: createSimpleGraph(),
    createStateView: () => ({ workflow_id: 'test', run_id: 'test', goal: 'test', constraints: [], memory: {} }),
    deps: {} as any,
    ...overrides,
  };
}

describe('executeRouterNode', () => {
  describe('basic execution', () => {
    it('returns an action with type update_memory', async () => {
      const node = makeNode({ id: 'router-1', type: 'router' });
      const ctx = createMockCtx();
      const stateView = ctx.createStateView(node);

      const action = await executeRouterNode(node, stateView, 0, ctx);

      expect(action.type).toBe('update_memory');
    });

    it('returns empty updates in payload', async () => {
      const node = makeNode({ id: 'router-1', type: 'router' });
      const ctx = createMockCtx();
      const stateView = ctx.createStateView(node);

      const action = await executeRouterNode(node, stateView, 0, ctx);

      expect(action.payload).toEqual({ updates: {} });
    });
  });

  describe('action ID', () => {
    it('generates a valid UUID for each call', async () => {
      const node = makeNode({ id: 'router-1', type: 'router' });
      const ctx = createMockCtx();
      const stateView = ctx.createStateView(node);

      const action = await executeRouterNode(node, stateView, 0, ctx);

      expect(action.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });

    it('generates unique IDs across multiple calls', async () => {
      const node = makeNode({ id: 'router-1', type: 'router' });
      const ctx = createMockCtx();
      const stateView = ctx.createStateView(node);

      const action1 = await executeRouterNode(node, stateView, 0, ctx);
      const action2 = await executeRouterNode(node, stateView, 0, ctx);

      expect(action1.id).not.toBe(action2.id);
    });
  });

  describe('idempotency key', () => {
    it('follows format nodeId:iterationCount:attempt', async () => {
      const node = makeNode({ id: 'router-1', type: 'router' });
      const ctx = createMockCtx({ state: createTestState({ iteration_count: 5 }) });
      const stateView = ctx.createStateView(node);

      const action = await executeRouterNode(node, stateView, 2, ctx);

      expect(action.idempotency_key).toBe('router-1:5:2');
    });

    it('different iteration counts produce different keys', async () => {
      const node = makeNode({ id: 'router-1', type: 'router' });
      const stateView = { workflow_id: 'test', run_id: 'test', goal: 'test', constraints: [], memory: {} };

      const ctx1 = createMockCtx({ state: createTestState({ iteration_count: 0 }) });
      const ctx2 = createMockCtx({ state: createTestState({ iteration_count: 10 }) });

      const action1 = await executeRouterNode(node, stateView, 0, ctx1);
      const action2 = await executeRouterNode(node, stateView, 0, ctx2);

      expect(action1.idempotency_key).toBe('router-1:0:0');
      expect(action2.idempotency_key).toBe('router-1:10:0');
      expect(action1.idempotency_key).not.toBe(action2.idempotency_key);
    });

    it('different attempt numbers produce different keys', async () => {
      const node = makeNode({ id: 'router-1', type: 'router' });
      const ctx = createMockCtx();
      const stateView = ctx.createStateView(node);

      const action1 = await executeRouterNode(node, stateView, 0, ctx);
      const action2 = await executeRouterNode(node, stateView, 1, ctx);

      expect(action1.idempotency_key).toBe('router-1:5:0');
      expect(action2.idempotency_key).toBe('router-1:5:1');
    });
  });

  describe('metadata', () => {
    it('contains correct node_id', async () => {
      const node = makeNode({ id: 'my-router', type: 'router' });
      const ctx = createMockCtx();
      const stateView = ctx.createStateView(node);

      const action = await executeRouterNode(node, stateView, 0, ctx);

      expect(action.metadata.node_id).toBe('my-router');
    });

    it('contains a timestamp that is a Date', async () => {
      const node = makeNode({ id: 'router-1', type: 'router' });
      const ctx = createMockCtx();
      const stateView = ctx.createStateView(node);

      const action = await executeRouterNode(node, stateView, 0, ctx);

      expect(action.metadata.timestamp).toBeInstanceOf(Date);
    });

    it('contains the correct attempt number', async () => {
      const node = makeNode({ id: 'router-1', type: 'router' });
      const ctx = createMockCtx();
      const stateView = ctx.createStateView(node);

      const action = await executeRouterNode(node, stateView, 3, ctx);

      expect(action.metadata.attempt).toBe(3);
    });
  });

  describe('stateView is unused', () => {
    it('different state views produce identical action structure', async () => {
      const node = makeNode({ id: 'router-1', type: 'router' });
      const ctx = createMockCtx();

      const stateView1 = { workflow_id: 'w1', run_id: 'r1', goal: 'goal-a', constraints: [], memory: { key: 'value' } };
      const stateView2 = { workflow_id: 'w2', run_id: 'r2', goal: 'goal-b', constraints: ['c1'], memory: {} };

      const action1 = await executeRouterNode(node, stateView1, 0, ctx);
      const action2 = await executeRouterNode(node, stateView2, 0, ctx);

      expect(action1.type).toBe(action2.type);
      expect(action1.payload).toEqual(action2.payload);
      expect(action1.idempotency_key).toBe(action2.idempotency_key);
      expect(action1.metadata.node_id).toBe(action2.metadata.node_id);
      expect(action1.metadata.attempt).toBe(action2.metadata.attempt);
    });
  });

  describe('different node IDs', () => {
    it('reflects the node ID in action metadata and idempotency key', async () => {
      const ctx = createMockCtx({ state: createTestState({ iteration_count: 1 }) });
      const stateView = ctx.createStateView(makeNode());

      const nodeA = makeNode({ id: 'router-alpha', type: 'router' });
      const nodeB = makeNode({ id: 'router-beta', type: 'router' });

      const actionA = await executeRouterNode(nodeA, stateView, 0, ctx);
      const actionB = await executeRouterNode(nodeB, stateView, 0, ctx);

      expect(actionA.metadata.node_id).toBe('router-alpha');
      expect(actionB.metadata.node_id).toBe('router-beta');
      expect(actionA.idempotency_key).toBe('router-alpha:1:0');
      expect(actionB.idempotency_key).toBe('router-beta:1:0');
    });
  });
});
