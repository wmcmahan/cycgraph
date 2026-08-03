/**
 * Unit tests for the reference graph builders.
 *
 * Validates structural correctness of each graph + registry + initial
 * state combination. No LLM is invoked.
 */

import { describe, it, expect } from 'vitest';
import { buildSupervisorGraph } from '../../src/sut/graphs/supervisor.js';
import { buildBranchingGraph } from '../../src/sut/graphs/branching.js';
import { buildRetryGraph } from '../../src/sut/graphs/retry.js';
import {
  createFlakyFetch,
  createRateLimitedCall,
} from '../../src/sut/fixtures/retry-tools.js';

describe('buildSupervisorGraph', () => {
  it('builds a cyclic hub-and-spoke graph with 4 nodes', () => {
    const artifacts = buildSupervisorGraph({
      input: 'Write an article about renewable energy.',
    });

    expect(artifacts.graph.nodes).toHaveLength(4);
    expect(artifacts.graph.start_node).toBe('supervisor');
    expect(artifacts.graph.end_nodes).toEqual([]);

    const nodeIds = artifacts.graph.nodes.map(n => n.id).sort();
    expect(nodeIds).toEqual(['edit', 'research', 'supervisor', 'write']);

    expect(artifacts.graph.edges).toHaveLength(6);
  });

  it('configures the supervisor node with managed nodes', () => {
    const artifacts = buildSupervisorGraph({
      input: 'goal',
      maxIterations: 5,
    });

    const supervisor = artifacts.graph.nodes.find(n => n.id === 'supervisor');
    expect(supervisor?.type).toBe('supervisor');
    if (supervisor?.type !== 'supervisor') throw new Error('expected supervisor');
    expect(supervisor.supervisor_config?.managed_nodes).toEqual([
      'research',
      'write',
      'edit',
    ]);
    expect(supervisor.supervisor_config?.max_iterations).toBe(5);
  });

  it('writes final output to the editor node and uses the configured outputKey', () => {
    const artifacts = buildSupervisorGraph({
      input: 'goal',
      outputKey: 'polished_article',
    });

    expect(artifacts.outputKey).toBe('polished_article');
    const editor = artifacts.graph.nodes.find(n => n.id === 'edit');
    expect(editor?.write_keys).toEqual(['polished_article']);
  });

  it('registers all 4 agents in the registry', async () => {
    const artifacts = buildSupervisorGraph({ input: 'goal' });

    const agentIds = artifacts.graph.nodes
      .filter(n => n.type === 'agent' || n.type === 'supervisor')
      .map(n => (n.type === 'agent' || n.type === 'supervisor') ? n.agent_id : '');

    for (const id of agentIds) {
      const agent = await artifacts.agentRegistry.loadAgent(id);
      expect(agent).not.toBeNull();
    }
  });
});

describe('buildBranchingGraph', () => {
  it('produces a single-agent graph with save_to_memory access', async () => {
    const artifacts = buildBranchingGraph({
      input: 'If costs exceed $10k, require approval; otherwise auto-approve.',
    });

    expect(artifacts.graph.nodes).toHaveLength(1);
    expect(artifacts.outputKey).toBe('decision');

    const node = artifacts.graph.nodes[0];
    if (node.type !== 'agent') throw new Error('expected agent node');
    const agent = await artifacts.agentRegistry.loadAgent(node.agent_id);
    expect(agent).not.toBeNull();
    expect(agent!.tools).toEqual([
      { type: 'builtin', name: 'save_to_memory' },
    ]);
  });

  it('threads goal through to initial state', () => {
    const artifacts = buildBranchingGraph({
      input: 'Branch on sentiment.',
    });
    expect(artifacts.initialState.goal).toBe('Branch on sentiment.');
  });

  it('honors custom outputKey', () => {
    const artifacts = buildBranchingGraph({
      input: 'x',
      outputKey: 'routing_choice',
    });
    expect(artifacts.outputKey).toBe('routing_choice');
    expect(artifacts.graph.nodes[0].write_keys).toEqual(['routing_choice']);
  });
});

describe('buildRetryGraph', () => {
  it('declares the flaky tool as an MCP source', async () => {
    const artifacts = buildRetryGraph({
      input: 'Fetch the data from the unreliable API.',
    });

    expect(artifacts.toolName).toBe('flaky_fetch');
    const node = artifacts.graph.nodes[0];
    if (node.type !== 'agent') throw new Error('expected agent node');
    const agent = await artifacts.agentRegistry.loadAgent(node.agent_id);
    expect(agent!.tools).toEqual([
      { type: 'mcp', server_id: 'mock', tool_names: ['flaky_fetch'] },
    ]);
  });

  it('elevates max_retries for the agent node', () => {
    const artifacts = buildRetryGraph({ input: 'x' });
    expect(artifacts.graph.nodes[0].failure_policy.max_retries).toBe(3);
  });

  it('honors a custom toolName', async () => {
    const artifacts = buildRetryGraph({ input: 'x', toolName: 'rate_limited_call' });
    expect(artifacts.toolName).toBe('rate_limited_call');

    const node = artifacts.graph.nodes[0];
    if (node.type !== 'agent') throw new Error('expected agent node');
    const agent = await artifacts.agentRegistry.loadAgent(node.agent_id);
    expect(agent!.tools).toEqual([
      { type: 'mcp', server_id: 'mock', tool_names: ['rate_limited_call'] },
    ]);
  });
});

describe('retry-tool fixtures', () => {
  it('createFlakyFetch returns failures then a success', () => {
    const tool = createFlakyFetch({ failuresBeforeSuccess: 2 });

    const r1 = tool({}) as { status: string; attempt: number };
    expect(r1.status).toBe('failed');
    expect(r1.attempt).toBe(1);

    const r2 = tool({}) as { status: string; attempt: number };
    expect(r2.status).toBe('failed');
    expect(r2.attempt).toBe(2);

    const r3 = tool({}) as { status: string; attempt: number };
    expect(r3.status).toBe('ok');
    expect(r3.attempt).toBe(3);

    const r4 = tool({}) as { status: string };
    expect(r4.status).toBe('ok');
  });

  it('createFlakyFetch uses custom failure messages in order', () => {
    const tool = createFlakyFetch({
      failuresBeforeSuccess: 3,
      failureMessages: ['fail-a', 'fail-b', 'fail-c'],
    });

    expect((tool({}) as { error: string }).error).toBe('fail-a');
    expect((tool({}) as { error: string }).error).toBe('fail-b');
    expect((tool({}) as { error: string }).error).toBe('fail-c');
    expect((tool({}) as { status: string }).status).toBe('ok');
  });

  it('createRateLimitedCall inserts 429s every Nth call', () => {
    const tool = createRateLimitedCall({ totalCalls: 5, rateLimitEvery: 2 });

    expect((tool({}) as { status: number }).status).toBe(200);
    expect((tool({}) as { status: number }).status).toBe(429);
    expect((tool({}) as { status: number }).status).toBe(200);
    expect((tool({}) as { status: number }).status).toBe(429);
  });

  it('createRateLimitedCall returns "done" once totalCalls successes are delivered', () => {
    const tool = createRateLimitedCall({ totalCalls: 1, rateLimitEvery: 100 });

    expect((tool({}) as { status: number }).status).toBe(200);
    const done = tool({}) as { status: string };
    expect(done.status).toBe('done');
  });

  it('flaky fixtures are stateful per closure (not shared across calls)', () => {
    const a = createFlakyFetch({ failuresBeforeSuccess: 1 });
    const b = createFlakyFetch({ failuresBeforeSuccess: 1 });

    expect((a({}) as { status: string }).status).toBe('failed');
    expect((b({}) as { status: string }).status).toBe('failed');
  });
});
