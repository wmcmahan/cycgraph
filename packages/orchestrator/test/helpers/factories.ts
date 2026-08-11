/**
 * Shared Test Factories — reusable state, node, and graph builders.
 *
 * This file contains ONLY factory functions, NO vi.mock calls.
 * Safe to import from any test file without triggering mock hoisting.
 *
 * Usage:
 *   import { createTestState, makeNode, createLinearGraph } from './helpers/factories';
 */

import { v4 as uuidv4 } from 'uuid';
import type { Graph, GraphInput, GraphNode } from '../../src/graph/graph.js';
import type { WorkflowState } from '../../src/state/state.js';
import { createWorkflowState } from '../../src/state/state.js';

/**
 * Create a test WorkflowState with sensible defaults.
 */
export function createTestState(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return createWorkflowState({
    workflow_id: uuidv4(),
    goal: 'Test goal',
    ...overrides,
  });
}

/**
 * Create a graph node with sensible defaults.
 */
export function makeNode(overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    id: 'node-1',
    type: 'agent',
    agent_id: 'test-agent',
    read_keys: ['*'],
    write_keys: ['*'],
    failure_policy: {
      max_retries: 3,
      backoff_strategy: 'exponential',
      initial_backoff_ms: 1000,
      max_backoff_ms: 60000,
    },
    requires_compensation: false,
    ...overrides,
  } as GraphNode;
}

/**
 * Create a simple single-node agent graph for testing.
 */
export function createSimpleGraph(overrides: Partial<GraphInput> = {}): Graph {
  return {
    id: uuidv4(),
    name: 'Test Graph',
    description: 'Simple test graph',
    nodes: [{
      id: 'agent-node',
      type: 'agent',
      agent_id: 'test-agent',
      read_keys: ['*'],
      write_keys: ['*'],
      failure_policy: { max_retries: 1, backoff_strategy: 'fixed' as const, initial_backoff_ms: 100, max_backoff_ms: 100 },
      requires_compensation: false,
    }],
    edges: [],
    start_node: 'agent-node',
    end_nodes: ['agent-node'],
    ...overrides,
  } as Graph;
}

/**
 * Create a 2-node linear graph: node-1 → node-2.
 */
export function createLinearGraph(overrides: Partial<GraphInput> = {}): Graph {
  return {
    id: uuidv4(),
    name: 'Linear Test Graph',
    description: 'Simple linear graph for testing',
    nodes: [
      makeNode({ id: 'node-1', agent_id: 'agent-1' }),
      makeNode({ id: 'node-2', agent_id: 'agent-2' }),
    ],
    edges: [{
      id: 'edge-1',
      source: 'node-1',
      target: 'node-2',
      condition: { type: 'always' },
    }],
    start_node: 'node-1',
    end_nodes: ['node-2'],
    ...overrides,
  } as Graph;
}
