/**
 * Tests for the `a2a` node (execution/nodes/a2a.ts) and its authoring
 * primitive.
 *
 * The client is a port, so the executor's decisions are testable without a
 * network: what crosses out, what comes back, what is tainted, and which
 * non-completed states must not be retried.
 */

import { describe, it, expect } from 'vitest';
import { executeA2ANode } from '../src/execution/nodes/a2a.js';
import { A2ATaskFailedError } from '../src/execution/nodes/errors.js';
import { NodeConfigError } from '../src/execution/errors.js';
import { InMemoryA2AServerRegistry } from '../src/a2a/in-memory-registry.js';
import { a2a } from '../src/authoring/a2a.js';
import { graph } from '../src/authoring/graph.js';
import { impliedResultKeys } from '../src/security/effective-permissions.js';
import { validateGraph } from '../src/graph/graph-validator.js';
import type { A2AClient, A2ATaskResult, A2ATaskState } from '../src/a2a/client.js';
import type { NodeExecutorContext } from '../src/execution/nodes/context.js';
import type { GraphNode } from '../src/graph/graph.js';
import type { StateView } from '../src/state/state.js';

const CARD_URL = 'https://agents.example.com/.well-known/agent-card.json';

async function registryWith(overrides: Record<string, unknown> = {}) {
  const registry = new InMemoryA2AServerRegistry();
  await registry.saveServer({
    id: 'research-service',
    name: 'Research Service',
    agentCardUrl: CARD_URL,
    ...overrides,
  });
  return registry;
}

function fakeClient(
  result: Partial<A2ATaskResult>,
  capture?: { request?: unknown; resume?: unknown },
  resumeResult?: Partial<A2ATaskResult>,
): A2AClient {
  const terminal = (over: Partial<A2ATaskResult>): A2ATaskResult => ({
    taskId: 'task-1', state: 'completed', artifacts: [], ...over,
  });
  return {
    runTask: async (request) => {
      if (capture) capture.request = request;
      return terminal(result);
    },
    resumeTask: async (request) => {
      if (capture) capture.resume = request;
      return terminal(resumeResult ?? { artifacts: [{ name: 'report', value: 'after answer' }] });
    },
  };
}

function node(overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    id: 'research',
    type: 'a2a',
    read_keys: ['topic'],
    write_keys: [],
    requires_compensation: false,
    failure_policy: { max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 0, max_backoff_ms: 0 },
    a2a_config: {
      server_id: 'research-service',
      input_mapping: { topic: 'query' },
      output_mapping: { report: 'findings' },
    },
    ...overrides,
  } as GraphNode;
}

function stateView(memory: Record<string, unknown> = { topic: 'batteries' }): StateView {
  return {
    workflow_id: '00000000-0000-0000-0000-000000000001',
    run_id: '00000000-0000-0000-0000-000000000002',
    goal: 'research',
    constraints: [],
    memory,
  } as unknown as StateView;
}

async function ctxWith(
  client: A2AClient,
  registry?: InMemoryA2AServerRegistry,
  state: Record<string, unknown> = {},
): Promise<NodeExecutorContext> {
  return {
    state: { iteration_count: 0, memory: {}, subgraph_checkpoints: {}, ...state },
    a2aRegistry: registry ?? (await registryWith()),
    a2aClient: client,
  } as unknown as NodeExecutorContext;
}

describe('executeA2ANode', () => {
  it('sends the mapped input to the resolved endpoint', async () => {
    const capture: { request?: any } = {};
    const client = fakeClient({ artifacts: [{ name: 'report', value: 'done' }] }, capture);

    await executeA2ANode(node(), stateView(), 1, await ctxWith(client));

    expect(capture.request.agentCardUrl).toBe(CARD_URL);
    expect(capture.request.input).toEqual({ query: 'batteries' });
  });

  it('maps artifacts back to the parent keys the mapping names', async () => {
    const client = fakeClient({
      artifacts: [{ name: 'report', value: 'the findings' }, { name: 'ignored', value: 'x' }],
    });

    const action = await executeA2ANode(node(), stateView(), 1, await ctxWith(client));

    expect((action.payload as any).updates.findings).toBe('the findings');
    expect((action.payload as any).updates).not.toHaveProperty('ignored');
  });

  it('taints everything the remote agent returned', async () => {
    const client = fakeClient({ artifacts: [{ name: 'report', value: 'from outside' }] });

    const action = await executeA2ANode(node(), stateView(), 1, await ctxWith(client));

    expect((action.payload as any).updates._taint_registry.findings).toMatchObject({
      source: 'a2a',
      server_id: 'research-service',
    });
  });

  it('preserves structured artifact values rather than flattening them', async () => {
    const client = fakeClient({ artifacts: [{ name: 'report', value: { score: 0.9, items: ['a'] } }] });

    const action = await executeA2ANode(node(), stateView(), 1, await ctxWith(client));

    expect((action.payload as any).updates.findings).toEqual({ score: 0.9, items: ['a'] });
  });

  it('sends no header when the server is unauthenticated', async () => {
    const capture: { request?: any } = {};

    await executeA2ANode(node(), stateView(), 1, await ctxWith(fakeClient({}, capture)));

    expect(capture.request.headers).toEqual({});
  });

  it('resolves the per-node wait override ahead of the registry default', async () => {
    const capture: { request?: any } = {};
    const withOverride = node({
      a2a_config: {
        server_id: 'research-service',
        input_mapping: {},
        output_mapping: {},
        max_wait_ms: 5_000,
      },
    } as Partial<GraphNode>);

    await executeA2ANode(withOverride, stateView(), 1, await ctxWith(fakeClient({}, capture)));

    expect(capture.request.timeoutMs).toBe(5_000);
  });

  it('falls back to the registry task timeout when the node sets none', async () => {
    const capture: { request?: any } = {};

    await executeA2ANode(node(), stateView(), 1, await ctxWith(fakeClient({}, capture)));

    expect(capture.request.timeoutMs).toBe(600_000);
  });

  it('errors when no registry is configured', async () => {
    const ctx = { state: { iteration_count: 0 }, a2aClient: fakeClient({}) } as unknown as NodeExecutorContext;

    await expect(executeA2ANode(node(), stateView(), 1, ctx)).rejects.toThrow(NodeConfigError);
  });

  it('errors when no client is supplied', async () => {
    const ctx = { state: { iteration_count: 0 }, a2aRegistry: await registryWith() } as unknown as NodeExecutorContext;

    await expect(executeA2ANode(node(), stateView(), 1, ctx)).rejects.toThrow(NodeConfigError);
  });

  it('errors when the named server is not registered', async () => {
    const missing = node({
      a2a_config: { server_id: 'unknown', input_mapping: {}, output_mapping: {} },
    } as Partial<GraphNode>);

    await expect(executeA2ANode(missing, stateView(), 1, await ctxWith(fakeClient({}))))
      .rejects.toThrow(/unknown/);
  });

  it('refuses an agent the server allowlist excludes', async () => {
    const registry = await registryWith({ allowedAgents: ['approved-agent'] });
    const restricted = node({ agent_id: 'other-agent' });

    await expect(executeA2ANode(restricted, stateView(), 1, await ctxWith(fakeClient({}), registry)))
      .rejects.toThrow(/permitted to use/);
  });

});

describe('executeA2ANode — non-completed task states', () => {
  const cases: A2ATaskState[] = ['failed', 'rejected', 'canceled', 'auth-required'];

  for (const state of cases) {
    it(`throws A2ATaskFailedError for "${state}"`, async () => {
      const client = fakeClient({ state });

      await expect(executeA2ANode(node(), stateView(), 1, await ctxWith(client)))
        .rejects.toThrow(A2ATaskFailedError);
    });
  }

  it('marks a rejected task non-retryable so the runner stops', async () => {
    const client = fakeClient({ state: 'rejected' });

    await expect(executeA2ANode(node(), stateView(), 1, await ctxWith(client)))
      .rejects.toMatchObject({ retryable: false });
  });

  it('leaves a failed task retryable', async () => {
    const client = fakeClient({ state: 'failed' });

    await expect(executeA2ANode(node(), stateView(), 1, await ctxWith(client)))
      .rejects.toMatchObject({ retryable: undefined });
  });

  it('carries the task id so a failed task can be traced on the remote side', async () => {
    const client = fakeClient({ state: 'failed', taskId: 'task-42' });

    await expect(executeA2ANode(node(), stateView(), 1, await ctxWith(client)))
      .rejects.toMatchObject({ taskId: 'task-42' });
  });
});

describe('a2a', () => {
  it('compiles to an a2a node carrying the server id', () => {
    const value = a2a('research-service', {
      id: 'research',
      inputs: { topic: 'query' },
      outputs: { report: 'findings' },
    });

    expect(value.type).toBe('a2a');
    expect((value as any).a2aConfig.serverId).toBe('research-service');
  });

  it('records the skill as intent without inventing a wire field', () => {
    const value = a2a('research-service', { id: 'research', skill: 'deep-research' });

    expect((value as any).a2aConfig.skillId).toBe('deep-research');
  });

  it('produces a graph whose node validates', () => {
    const built = graph({
      name: 'remote',
      nodes: [a2a('research-service', {
        id: 'research',
        reads: ['topic'],
        inputs: { topic: 'query' },
        outputs: { report: 'findings' },
      })],
    });

    expect(validateGraph(built).valid).toBe(true);
    expect(built.nodes[0].a2a_config?.server_id).toBe('research-service');
  });
});

describe('impliedResultKeys — a2a', () => {
  it('implies the parent-side keys of the output mapping', () => {
    expect(impliedResultKeys(node())).toEqual(['findings']);
  });

  it('implies nothing when the node maps no outputs', () => {
    const bare = node({
      a2a_config: { server_id: 'research-service', input_mapping: {}, output_mapping: {} },
    } as Partial<GraphNode>);

    expect(impliedResultKeys(bare)).toEqual([]);
  });
});

describe('executeA2ANode — pausing for human input', () => {
  it('pauses the run rather than failing when the remote agent asks a question', async () => {
    const client = fakeClient({ state: 'input-required', taskId: 'task-7', message: 'Which region?' });

    const action = await executeA2ANode(node(), stateView(), 1, await ctxWith(client));

    expect(action.type).toBe('request_human_input');
  });

  it('surfaces the remote question as the approval prompt', async () => {
    const client = fakeClient({ state: 'input-required', taskId: 'task-7', message: 'Which region?' });

    const action = await executeA2ANode(node(), stateView(), 1, await ctxWith(client));

    expect((action.payload as any).pending_approval.prompt_message).toBe('Which region?');
  });

  it('falls back to a readable prompt when the agent sends no message', async () => {
    const client = fakeClient({ state: 'input-required', taskId: 'task-7' });

    const action = await executeA2ANode(node(), stateView(), 1, await ctxWith(client));

    expect((action.payload as any).pending_approval.prompt_message).toContain('research-service');
  });

  it('stashes the task id so the answer continues the same remote task', async () => {
    const client = fakeClient({ state: 'input-required', taskId: 'task-7' });

    const action = await executeA2ANode(node(), stateView(), 1, await ctxWith(client));

    expect((action.payload as any).memory_updates._subgraph_resume_research)
      .toEqual({ task_id: 'task-7' });
  });

  it('resumes the stashed task instead of starting a new one', async () => {
    const capture: { request?: any; resume?: any } = {};
    const client = fakeClient({}, capture);
    const ctx = await ctxWith(client, undefined, {
      subgraph_checkpoints: { research: { task_id: 'task-7' } },
      memory: { human_response: 'EMEA' },
    });

    await executeA2ANode(node(), stateView(), 1, ctx);

    expect(capture.request).toBeUndefined();
    expect(capture.resume.taskId).toBe('task-7');
  });

  it('forwards the human answer to the remote agent', async () => {
    const capture: { request?: any; resume?: any } = {};
    const ctx = await ctxWith(fakeClient({}, capture), undefined, {
      subgraph_checkpoints: { research: { task_id: 'task-7' } },
      memory: { human_response: 'EMEA' },
    });

    await executeA2ANode(node(), stateView(), 1, ctx);

    expect(capture.resume.response).toBe('EMEA');
  });

  it('clears the stash once the resumed task completes', async () => {
    const ctx = await ctxWith(fakeClient({}), undefined, {
      subgraph_checkpoints: { research: { task_id: 'task-7' } },
      memory: { human_response: 'EMEA' },
    });

    const action = await executeA2ANode(node(), stateView(), 1, ctx);

    expect((action.payload as any).updates._subgraph_resume_research).toBeUndefined();
    expect((action.payload as any).updates.findings).toBe('after answer');
  });

  it('marks auth-required non-retryable, since the same credential would be re-sent', async () => {
    const client = fakeClient({ state: 'auth-required' });

    await expect(executeA2ANode(node(), stateView(), 1, await ctxWith(client)))
      .rejects.toMatchObject({ retryable: false });
  });
});

describe('executeA2ANode — telemetry', () => {
  it('sends no trace context by default', async () => {
    const capture: { request?: any } = {};

    await executeA2ANode(node(), stateView(), 1, await ctxWith(fakeClient({}, capture)));

    expect('traceparent' in capture.request.headers).toBe(false);
  });

  it('sends no trace context to a server that has not opted in', async () => {
    const capture: { request?: any } = {};
    const registry = await registryWith({ propagateTraceContext: false });

    await executeA2ANode(node(), stateView(), 1, await ctxWith(fakeClient({}, capture), registry));

    expect('traceparent' in capture.request.headers).toBe(false);
  });

  it('keeps auth headers alongside trace context when opted in', async () => {
    process.env.A2A_TOKEN = 'secret';
    const capture: { request?: any } = {};
    const registry = await registryWith({
      propagateTraceContext: true,
      auth: { type: 'bearer', tokenEnv: 'A2A_TOKEN' },
    });

    await executeA2ANode(node(), stateView(), 1, await ctxWith(fakeClient({}, capture), registry));

    expect(capture.request.headers.authorization).toBe('Bearer secret');
    delete process.env.A2A_TOKEN;
  });
});
