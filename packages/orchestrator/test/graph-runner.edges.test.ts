/**
 * graph-runner.edges.test.ts
 *
 * Battle-tests for conditional edge routing and graph topology.
 * These tests verify that the runner correctly follows edges based on
 * JSONPath conditions against workflow state, handles diamond/branching
 * graphs, multi-node chains, and gracefully handles edge-case topologies
 * like no-matching-edge and dangling references.
 */
import { describe, test, expect, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';

// ─── Mocks ──────────────────────────────────────────────────────────────

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

/**
 * Key design: the agent-executor mock returns update_memory actions that
 * write a `decision` key to memory. This lets us set up conditional edges
 * that branch based on `$.memory.decision`.
 *
 * The mock returns different values depending on agent_id:
 *   - 'decider-A'   → writes { decision: 'A' }
 *   - 'decider-B'   → writes { decision: 'B' }
 *   - 'writer-high' → writes { score: 95 }
 *   - 'writer-low'  → writes { score: 30 }
 *   - 'flagger'     → writes { approved: true }
 *   - default        → writes { [agentId]_result: 'done' }
 */
vi.mock('../src/agent/agent-executor/executor', () => ({
  executeAgent: vi.fn(async (agentId: string, _stateView: any, _tools: any, attempt: number) => {
    const payloadMap: Record<string, Record<string, unknown>> = {
      'decider-A': { decision: 'A' },
      'decider-B': { decision: 'B' },
      'writer-high': { score: 95 },
      'writer-low': { score: 30 },
      'flagger': { approved: true },
      'no-approve': { approved: false },
    };

    const updates = payloadMap[agentId] ?? { [`${agentId}_result`]: 'done' };

    return {
      id: uuidv4(),
      idempotency_key: `${agentId}:mock:${attempt}`,
      type: 'update_memory',
      payload: { updates },
      metadata: { node_id: agentId, agent_id: agentId, timestamp: new Date(), attempt },
    };
  }),
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

vi.mock('../src/utils/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../src/utils/tracing', () => ({
  getTracer: () => ({}),
  withSpan: (_tracer: any, _name: string, fn: (span: any) => any) => fn({ setAttribute: vi.fn() }),
}));

import { GraphRunner } from '../src/runner/graph-runner.js';
import type { Graph, GraphNode } from '../src/types/graph.js';
import type { WorkflowState } from '../src/types/state.js';

// ─── Helpers ────────────────────────────────────────────────────────────

const makeNode = (overrides: Partial<GraphNode> & { id: string; type: GraphNode['type'] }): GraphNode => ({
  read_keys: ['*'],
  write_keys: ['*'],
  failure_policy: { max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 10, max_backoff_ms: 10 },
  requires_compensation: false,
  ...overrides,
});

const createState = (overrides: Partial<WorkflowState> = {}): WorkflowState => ({
  workflow_id: uuidv4(),
  run_id: uuidv4(),
  created_at: new Date(),
  updated_at: new Date(),
  goal: 'Edge routing test',
  constraints: [],
  status: 'pending',
  iteration_count: 0,
  retry_count: 0,
  max_retries: 3,
  memory: {},
  visited_nodes: [],
  max_iterations: 50,
  compensation_stack: [],
  max_execution_time_ms: 30000,
  supervisor_history: [],
  total_tokens_used: 0,
  ...overrides,
});

// ─── Tests ──────────────────────────────────────────────────────────────

describe('GraphRunner — Conditional Edge Routing', () => {
  /**
   * The most basic conditional edge: an equality comparison on a memory value.
   *
   * Graph:  start (writes decision='A') → [router] → branch-a (if decision=='A') OR branch-b
   *         branch-a → end
   *         branch-b → end
   *
   * Expected: router routes to branch-a because decision=='A'
   */
  test('should follow edge with JSONPath == string condition', async () => {
    const graph: Graph = {
      id: uuidv4(), name: 'Conditional String', description: '',
      nodes: [
        makeNode({ id: 'start', type: 'agent', agent_id: 'decider-A' }),
        makeNode({ id: 'router', type: 'router' }),
        makeNode({ id: 'branch-a', type: 'agent', agent_id: 'handler-a' }),
        makeNode({ id: 'branch-b', type: 'agent', agent_id: 'handler-b' }),
        makeNode({ id: 'end', type: 'agent', agent_id: 'finisher' }),
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'router', condition: { type: 'always' } },
        { id: 'e2', source: 'router', target: 'branch-a', condition: { type: 'conditional', condition: "$.memory.decision == 'A'" } },
        { id: 'e3', source: 'router', target: 'branch-b', condition: { type: 'conditional', condition: "$.memory.decision == 'B'" } },
        { id: 'e4', source: 'branch-a', target: 'end', condition: { type: 'always' } },
        { id: 'e5', source: 'branch-b', target: 'end', condition: { type: 'always' } },
      ],
      start_node: 'start',
      end_nodes: ['end'],
    };

    const runner = new GraphRunner(graph, createState());
    const final = await runner.run();

    expect(final.status).toBe('completed');
    expect(final.visited_nodes).toContain('branch-a');
    expect(final.visited_nodes).not.toContain('branch-b');
    // Path: start → router → branch-a → end
    expect(final.visited_nodes).toEqual(['start', 'router', 'branch-a', 'end']);
  });

  /**
   * Same graph but start writes decision='B' — verifies the OTHER branch is taken.
   * This catches off-by-one bugs where always the first edge matches.
   */
  test('should take second conditional edge when first does not match', async () => {
    const graph: Graph = {
      id: uuidv4(), name: 'Conditional Branch B', description: '',
      nodes: [
        makeNode({ id: 'start', type: 'agent', agent_id: 'decider-B' }),
        makeNode({ id: 'router', type: 'router' }),
        makeNode({ id: 'branch-a', type: 'agent', agent_id: 'handler-a' }),
        makeNode({ id: 'branch-b', type: 'agent', agent_id: 'handler-b' }),
        makeNode({ id: 'end', type: 'agent', agent_id: 'finisher' }),
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'router', condition: { type: 'always' } },
        { id: 'e2', source: 'router', target: 'branch-a', condition: { type: 'conditional', condition: "$.memory.decision == 'A'" } },
        { id: 'e3', source: 'router', target: 'branch-b', condition: { type: 'conditional', condition: "$.memory.decision == 'B'" } },
        { id: 'e4', source: 'branch-a', target: 'end', condition: { type: 'always' } },
        { id: 'e5', source: 'branch-b', target: 'end', condition: { type: 'always' } },
      ],
      start_node: 'start',
      end_nodes: ['end'],
    };

    const runner = new GraphRunner(graph, createState());
    const final = await runner.run();

    expect(final.status).toBe('completed');
    expect(final.visited_nodes).toContain('branch-b');
    expect(final.visited_nodes).not.toContain('branch-a');
  });

  /**
   * Numeric comparison: $.memory.score > 50
   * Agent 'writer-high' writes score=95, so the > 50 branch should be taken.
   */
  test('should follow edge with JSONPath > numeric condition', async () => {
    const graph: Graph = {
      id: uuidv4(), name: 'Numeric Compare', description: '',
      nodes: [
        makeNode({ id: 'scorer', type: 'agent', agent_id: 'writer-high' }),
        makeNode({ id: 'high-handler', type: 'agent', agent_id: 'handler-high' }),
        makeNode({ id: 'low-handler', type: 'agent', agent_id: 'handler-low' }),
      ],
      edges: [
        { id: 'e1', source: 'scorer', target: 'high-handler', condition: { type: 'conditional', condition: '$.memory.score > 50' } },
        { id: 'e2', source: 'scorer', target: 'low-handler', condition: { type: 'conditional', condition: '$.memory.score <= 50' } },
      ],
      start_node: 'scorer',
      end_nodes: ['high-handler', 'low-handler'],
    };

    const runner = new GraphRunner(graph, createState());
    const final = await runner.run();

    expect(final.status).toBe('completed');
    expect(final.visited_nodes).toContain('high-handler');
    expect(final.visited_nodes).not.toContain('low-handler');
  });

  /**
   * Same graph but with score=30 (writer-low) → takes the <= 50 branch.
   * This ensures both directions are exercised.
   */
  test('should follow edge with JSONPath <= numeric condition', async () => {
    const graph: Graph = {
      id: uuidv4(), name: 'Numeric Compare Low', description: '',
      nodes: [
        makeNode({ id: 'scorer', type: 'agent', agent_id: 'writer-low' }),
        makeNode({ id: 'high-handler', type: 'agent', agent_id: 'handler-high' }),
        makeNode({ id: 'low-handler', type: 'agent', agent_id: 'handler-low' }),
      ],
      edges: [
        { id: 'e1', source: 'scorer', target: 'high-handler', condition: { type: 'conditional', condition: '$.memory.score > 50' } },
        { id: 'e2', source: 'scorer', target: 'low-handler', condition: { type: 'conditional', condition: '$.memory.score <= 50' } },
      ],
      start_node: 'scorer',
      end_nodes: ['high-handler', 'low-handler'],
    };

    const runner = new GraphRunner(graph, createState());
    const final = await runner.run();

    expect(final.status).toBe('completed');
    expect(final.visited_nodes).toContain('low-handler');
    expect(final.visited_nodes).not.toContain('high-handler');
  });

  /**
   * Boolean truthiness check: $.memory.approved (no comparison operator).
   * Agent 'flagger' writes approved=true, so the edge should be followed.
   */
  test('should follow edge with JSONPath boolean truthiness check', async () => {
    const graph: Graph = {
      id: uuidv4(), name: 'Boolean Check', description: '',
      nodes: [
        makeNode({ id: 'checker', type: 'agent', agent_id: 'flagger' }),
        makeNode({ id: 'approved-path', type: 'agent', agent_id: 'approve-handler' }),
        makeNode({ id: 'rejected-path', type: 'agent', agent_id: 'reject-handler' }),
      ],
      edges: [
        { id: 'e1', source: 'checker', target: 'approved-path', condition: { type: 'conditional', condition: '$.memory.approved' } },
        // Fallback: always edge checked AFTER the conditional above
        { id: 'e2', source: 'checker', target: 'rejected-path', condition: { type: 'always' } },
      ],
      start_node: 'checker',
      end_nodes: ['approved-path', 'rejected-path'],
    };

    const runner = new GraphRunner(graph, createState());
    const final = await runner.run();

    expect(final.status).toBe('completed');
    expect(final.visited_nodes).toContain('approved-path');
    expect(final.visited_nodes).not.toContain('rejected-path');
  });

  /**
   * Boolean FALSE should NOT match the truthiness check.
   * Agent 'no-approve' writes approved=false, so the conditional edge
   * should NOT match — the fallback 'always' edge should be taken instead.
   */
  test('should skip conditional edge when boolean value is false', async () => {
    const graph: Graph = {
      id: uuidv4(), name: 'Boolean False', description: '',
      nodes: [
        makeNode({ id: 'checker', type: 'agent', agent_id: 'no-approve' }),
        makeNode({ id: 'approved-path', type: 'agent', agent_id: 'approve-handler' }),
        makeNode({ id: 'rejected-path', type: 'agent', agent_id: 'reject-handler' }),
      ],
      edges: [
        { id: 'e1', source: 'checker', target: 'approved-path', condition: { type: 'conditional', condition: '$.memory.approved' } },
        { id: 'e2', source: 'checker', target: 'rejected-path', condition: { type: 'always' } },
      ],
      start_node: 'checker',
      end_nodes: ['approved-path', 'rejected-path'],
    };

    const runner = new GraphRunner(graph, createState());
    const final = await runner.run();

    expect(final.status).toBe('completed');
    expect(final.visited_nodes).toContain('rejected-path');
    expect(final.visited_nodes).not.toContain('approved-path');
  });

  /**
   * Condition references a memory key that doesn't exist.
   * JSONPath should return an empty result set → condition evaluates to false.
   * The runner should not crash; it should fall through to the next edge or complete.
   */
  test('should gracefully handle condition referencing missing memory key', async () => {
    const graph: Graph = {
      id: uuidv4(), name: 'Missing Key', description: '',
      nodes: [
        makeNode({ id: 'start', type: 'agent', agent_id: 'generic-agent' }),
        makeNode({ id: 'guarded', type: 'agent', agent_id: 'handler' }),
        makeNode({ id: 'fallback', type: 'agent', agent_id: 'fallback-handler' }),
      ],
      edges: [
        // This condition references $.memory.nonexistent — not set by the agent
        { id: 'e1', source: 'start', target: 'guarded', condition: { type: 'conditional', condition: "$.memory.nonexistent == 'foo'" } },
        { id: 'e2', source: 'start', target: 'fallback', condition: { type: 'always' } },
      ],
      start_node: 'start',
      end_nodes: ['guarded', 'fallback'],
    };

    const runner = new GraphRunner(graph, createState());
    const final = await runner.run();

    expect(final.status).toBe('completed');
    expect(final.visited_nodes).toContain('fallback');
    expect(final.visited_nodes).not.toContain('guarded');
  });
});

describe('GraphRunner — No Matching Edge', () => {
  const deadEndGraph = (): Graph => ({
    id: uuidv4(), name: 'Dead End', description: '',
    nodes: [
      makeNode({ id: 'start', type: 'agent', agent_id: 'decider-A' }),
      makeNode({ id: 'unreachable', type: 'agent', agent_id: 'handler' }),
    ],
    edges: [
      // Condition never matches → 'start' (a non-end node) dead-ends.
      { id: 'e1', source: 'start', target: 'unreachable', condition: { type: 'conditional', condition: "$.memory.decision == 'Z'" } },
    ],
    start_node: 'start',
    end_nodes: ['unreachable'],
  });

  /**
   * A non-end node whose only edge condition never matches is a dead-end.
   * The runner must FAIL LOUD (not silently report "completed" having
   * executed only half the graph — the bug this guards against).
   */
  test('fails loud when no edge matches at a non-end node', async () => {
    const runner = new GraphRunner(deadEndGraph(), createState());
    await expect(runner.run()).rejects.toThrow(/no outgoing edge/);
  });

  test('allowImplicitCompletion restores legacy silent completion', async () => {
    const runner = new GraphRunner(deadEndGraph(), createState(), { allowImplicitCompletion: true });
    const final = await runner.run();

    expect(final.status).toBe('completed');
    expect(final.visited_nodes).toEqual(['start']);
    expect(final.visited_nodes).not.toContain('unreachable');
  });

  /**
   * Node has zero outgoing edges and is NOT in end_nodes.
   * The runner should still complete since getNextNode returns null.
   */
  test('should complete when node has no outgoing edges at all', async () => {
    const graph: Graph = {
      id: uuidv4(), name: 'No Outgoing', description: '',
      nodes: [
        makeNode({ id: 'only-node', type: 'agent', agent_id: 'solo' }),
      ],
      edges: [],
      start_node: 'only-node',
      end_nodes: ['only-node'],
    };

    const runner = new GraphRunner(graph, createState());
    const final = await runner.run();

    expect(final.status).toBe('completed');
    expect(final.visited_nodes).toEqual(['only-node']);
    expect(final.iteration_count).toBe(1);
  });
});

describe('GraphRunner — Graph Topology', () => {
  /**
   * Multi-node linear chain: A → B → C → D
   * Verifies that 3+ node chains work with correct ordering.
   */
  test('should execute a 4-node linear chain in order', async () => {
    const graph: Graph = {
      id: uuidv4(), name: '4-Node Chain', description: '',
      nodes: [
        makeNode({ id: 'step-1', type: 'agent', agent_id: 'agent-1' }),
        makeNode({ id: 'step-2', type: 'agent', agent_id: 'agent-2' }),
        makeNode({ id: 'step-3', type: 'agent', agent_id: 'agent-3' }),
        makeNode({ id: 'step-4', type: 'agent', agent_id: 'agent-4' }),
      ],
      edges: [
        { id: 'e1', source: 'step-1', target: 'step-2', condition: { type: 'always' } },
        { id: 'e2', source: 'step-2', target: 'step-3', condition: { type: 'always' } },
        { id: 'e3', source: 'step-3', target: 'step-4', condition: { type: 'always' } },
      ],
      start_node: 'step-1',
      end_nodes: ['step-4'],
    };

    const runner = new GraphRunner(graph, createState());
    const final = await runner.run();

    expect(final.status).toBe('completed');
    expect(final.visited_nodes).toEqual(['step-1', 'step-2', 'step-3', 'step-4']);
    expect(final.iteration_count).toBe(4);
  });

  /**
   * Diamond graph (a.k.a. "fork-join"):
   *
   *       start
   *      /     \
   *   left    right   (only one path taken based on condition)
   *      \     /
   *       end
   *
   * This tests that the graph correctly converges at the end node even
   * after a conditional fork. Only one branch should execute.
   */
  test('should handle diamond graph with conditional fork', async () => {
    const graph: Graph = {
      id: uuidv4(), name: 'Diamond', description: '',
      nodes: [
        makeNode({ id: 'start', type: 'agent', agent_id: 'writer-high' }), // score=95
        makeNode({ id: 'left', type: 'agent', agent_id: 'left-handler' }),
        makeNode({ id: 'right', type: 'agent', agent_id: 'right-handler' }),
        makeNode({ id: 'end', type: 'agent', agent_id: 'finisher' }),
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'left', condition: { type: 'conditional', condition: '$.memory.score > 50' } },
        { id: 'e2', source: 'start', target: 'right', condition: { type: 'conditional', condition: '$.memory.score <= 50' } },
        { id: 'e3', source: 'left', target: 'end', condition: { type: 'always' } },
        { id: 'e4', source: 'right', target: 'end', condition: { type: 'always' } },
      ],
      start_node: 'start',
      end_nodes: ['end'],
    };

    const runner = new GraphRunner(graph, createState());
    const final = await runner.run();

    expect(final.status).toBe('completed');
    expect(final.visited_nodes).toContain('left');
    expect(final.visited_nodes).not.toContain('right');
    expect(final.visited_nodes).toEqual(['start', 'left', 'end']);
  });

  /**
   * Router as the start node of a graph.
   * Tests that router works correctly even as the first node (when memory is empty).
   * Since memory is empty, conditional edges won't match — the fallback should be taken.
   */
  test('should handle router as start node with empty memory', async () => {
    const graph: Graph = {
      id: uuidv4(), name: 'Router Start', description: '',
      nodes: [
        makeNode({ id: 'router', type: 'router', write_keys: [] }),
        makeNode({ id: 'branch-a', type: 'agent', agent_id: 'handler-a' }),
        makeNode({ id: 'default-branch', type: 'agent', agent_id: 'default-handler' }),
      ],
      edges: [
        { id: 'e1', source: 'router', target: 'branch-a', condition: { type: 'conditional', condition: "$.memory.mode == 'advanced'" } },
        { id: 'e2', source: 'router', target: 'default-branch', condition: { type: 'always' } },
      ],
      start_node: 'router',
      end_nodes: ['branch-a', 'default-branch'],
    };

    const runner = new GraphRunner(graph, createState());
    const final = await runner.run();

    expect(final.status).toBe('completed');
    // Empty memory → conditional edge fails → fallback 'always' edge taken
    expect(final.visited_nodes).toContain('default-branch');
    expect(final.visited_nodes).not.toContain('branch-a');
  });

  /**
   * Pre-populated memory can influence routing from the very first edge.
   * If memory is seeded with { mode: 'advanced' }, the conditional edge should match.
   */
  test('should route based on pre-populated initial memory', async () => {
    const graph: Graph = {
      id: uuidv4(), name: 'Seeded Memory', description: '',
      nodes: [
        makeNode({ id: 'router', type: 'router', write_keys: [] }),
        makeNode({ id: 'advanced', type: 'agent', agent_id: 'advanced-handler' }),
        makeNode({ id: 'basic', type: 'agent', agent_id: 'basic-handler' }),
      ],
      edges: [
        { id: 'e1', source: 'router', target: 'advanced', condition: { type: 'conditional', condition: "$.memory.mode == 'advanced'" } },
        { id: 'e2', source: 'router', target: 'basic', condition: { type: 'always' } },
      ],
      start_node: 'router',
      end_nodes: ['advanced', 'basic'],
    };

    const state = createState({ memory: { mode: 'advanced' } });
    const runner = new GraphRunner(graph, state);
    const final = await runner.run();

    expect(final.status).toBe('completed');
    expect(final.visited_nodes).toContain('advanced');
    expect(final.visited_nodes).not.toContain('basic');
  });

  /**
   * Edge ordering matters: getNextNode iterates edges in array order and
   * takes the FIRST match. This test verifies that when two edges both
   * match, the first one wins.
   */
  test('should take first matching edge when multiple conditions are true', async () => {
    const graph: Graph = {
      id: uuidv4(), name: 'Edge Priority', description: '',
      nodes: [
        makeNode({ id: 'start', type: 'agent', agent_id: 'flagger' }), // approved=true
        makeNode({ id: 'first-match', type: 'agent', agent_id: 'handler-1' }),
        makeNode({ id: 'second-match', type: 'agent', agent_id: 'handler-2' }),
      ],
      edges: [
        // Both edges will match: 'always' and a truthy condition
        { id: 'e1', source: 'start', target: 'first-match', condition: { type: 'always' } },
        { id: 'e2', source: 'start', target: 'second-match', condition: { type: 'always' } },
      ],
      start_node: 'start',
      end_nodes: ['first-match', 'second-match'],
    };

    const runner = new GraphRunner(graph, createState());
    const final = await runner.run();

    expect(final.status).toBe('completed');
    // First edge in array wins
    expect(final.visited_nodes).toContain('first-match');
    expect(final.visited_nodes).not.toContain('second-match');
  });

  /**
   * Iteration count should accurately reflect total nodes executed,
   * not edges traversed or conditions evaluated.
   */
  test('should accurately count iterations for multi-node execution', async () => {
    const graph: Graph = {
      id: uuidv4(), name: 'Count Test', description: '',
      nodes: [
        makeNode({ id: 'a', type: 'agent', agent_id: 'agent-a' }),
        makeNode({ id: 'b', type: 'agent', agent_id: 'agent-b' }),
        makeNode({ id: 'c', type: 'agent', agent_id: 'agent-c' }),
      ],
      edges: [
        { id: 'e1', source: 'a', target: 'b', condition: { type: 'always' } },
        { id: 'e2', source: 'b', target: 'c', condition: { type: 'always' } },
      ],
      start_node: 'a',
      end_nodes: ['c'],
    };

    const runner = new GraphRunner(graph, createState());
    const final = await runner.run();

    // 3 nodes executed = 3 iterations
    expect(final.iteration_count).toBe(3);
    expect(final.visited_nodes).toHaveLength(3);
  });
});

describe('GraphRunner — Edge Condition Types', () => {
  /**
   * The 'conditional' type with no condition string should evaluate to false.
   * This is a malformed edge — the runner should not crash.
   */
  test('should not follow conditional edge with missing condition string', async () => {
    const graph: Graph = {
      id: uuidv4(), name: 'Missing Condition', description: '',
      nodes: [
        makeNode({ id: 'start', type: 'agent', agent_id: 'generic-agent' }),
        makeNode({ id: 'guarded', type: 'agent', agent_id: 'handler' }),
        makeNode({ id: 'fallback', type: 'agent', agent_id: 'fallback-handler' }),
      ],
      edges: [
        // type: 'conditional' but no condition string → should be false
        { id: 'e1', source: 'start', target: 'guarded', condition: { type: 'conditional' } },
        { id: 'e2', source: 'start', target: 'fallback', condition: { type: 'always' } },
      ],
      start_node: 'start',
      end_nodes: ['guarded', 'fallback'],
    };

    const runner = new GraphRunner(graph, createState());
    const final = await runner.run();

    expect(final.status).toBe('completed');
    expect(final.visited_nodes).toContain('fallback');
    expect(final.visited_nodes).not.toContain('guarded');
  });

  /**
   * JSONPath != (not equal) comparison.
   */
  test('should follow edge with JSONPath != condition', async () => {
    const graph: Graph = {
      id: uuidv4(), name: 'Not Equal', description: '',
      nodes: [
        makeNode({ id: 'start', type: 'agent', agent_id: 'decider-A' }), // decision='A'
        makeNode({ id: 'not-b', type: 'agent', agent_id: 'handler-not-b' }),
        makeNode({ id: 'is-b', type: 'agent', agent_id: 'handler-is-b' }),
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'not-b', condition: { type: 'conditional', condition: "$.memory.decision != 'B'" } },
        { id: 'e2', source: 'start', target: 'is-b', condition: { type: 'conditional', condition: "$.memory.decision == 'B'" } },
      ],
      start_node: 'start',
      end_nodes: ['not-b', 'is-b'],
    };

    const runner = new GraphRunner(graph, createState());
    const final = await runner.run();

    expect(final.status).toBe('completed');
    // decision is 'A', not 'B' → != 'B' is true
    expect(final.visited_nodes).toContain('not-b');
  });

  /**
   * Unknown condition type (not 'always', 'conditional', or 'map') should be treated
   * as false. The runner should not crash.
   */
  test('should treat unknown condition type as false', async () => {
    const graph: Graph = {
      id: uuidv4(), name: 'Unknown Type', description: '',
      nodes: [
        makeNode({ id: 'start', type: 'agent', agent_id: 'generic-agent' }),
        makeNode({ id: 'unknown-edge', type: 'agent', agent_id: 'handler' }),
        makeNode({ id: 'safe', type: 'agent', agent_id: 'safe-handler' }),
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'unknown-edge', condition: { type: 'nonsense_type' as any } },
        { id: 'e2', source: 'start', target: 'safe', condition: { type: 'always' } },
      ],
      start_node: 'start',
      end_nodes: ['unknown-edge', 'safe'],
    };

    const runner = new GraphRunner(graph, createState());
    const final = await runner.run();

    expect(final.status).toBe('completed');
    expect(final.visited_nodes).toContain('safe');
    expect(final.visited_nodes).not.toContain('unknown-edge');
  });
});
