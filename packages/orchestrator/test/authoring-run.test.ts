/**
 * Tests for the run()/state() facade helpers (src/authoring/run.ts). The
 * GraphRunner is mocked so these assert run()'s own logic — scoping the
 * graph's agents and providers into the runner options (no process-global
 * mutation), state construction, persistence wiring, and returning final
 * memory — without executing an LLM.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WorkflowState } from '../src/state/state.js';

const runnerRun = vi.hoisted(() => vi.fn());
const runnerCtor = vi.hoisted(() => vi.fn());

vi.mock('../src/execution/engine/graph-runner.js', () => ({
  GraphRunner: class {
    constructor(...args: unknown[]) {
      runnerCtor(...args);
    }
    run = runnerRun;
  },
}));

import { z } from 'zod';
import { agent } from '../src/authoring/agent.js';
import { node } from '../src/authoring/node.js';
import { graph } from '../src/authoring/graph.js';
import { run, state } from '../src/authoring/run.js';
import { tool } from '../src/tools/define-tool.js';

type RunnerOptions = {
  registry?: { loadAgent: (id: string) => Promise<unknown> };
  providers?: unknown;
  persistState?: unknown;
  middleware?: unknown;
  tools?: unknown[];
};

function linearGraph() {
  const research = node({
    id: 'research',
    agent: agent({ id: 'research-agent', model: 'claude-sonnet-4-6', instructions: 'r' }),
    reads: ['goal'],
    writes: 'notes',
  });
  const write = node({
    id: 'write',
    agent: agent({ id: 'write-agent', model: 'claude-sonnet-4-6', instructions: 'w' }),
    reads: ['notes'],
    writes: 'draft',
  });
  return graph({ name: 'rw', nodes: [research, write], edges: [{ from: research, to: write }] });
}

function ctorOptions(): RunnerOptions {
  return runnerCtor.mock.calls[0][2] as RunnerOptions;
}

beforeEach(() => {
  runnerCtor.mockClear();
  runnerRun.mockReset();
  runnerRun.mockResolvedValue({ memory: { draft: 'done' } } as WorkflowState);
});

describe('run', () => {
  it('returns the final workflow memory', async () => {
    const result = await run(linearGraph(), { goal: 'explain' });

    expect(result).toEqual({ draft: 'done' });
  });

  it('scopes the graph’s facade agents into a run registry (no global mutation)', async () => {
    await run(linearGraph(), { goal: 'explain' });

    const registry = ctorOptions().registry!;
    await expect(registry.loadAgent('research-agent')).resolves.toMatchObject({ id: 'research-agent' });
    await expect(registry.loadAgent('write-agent')).resolves.toMatchObject({ id: 'write-agent' });
  });

  it('leaves providers unset by default so the run inherits the global registry', async () => {
    await run(linearGraph(), { goal: 'explain' });

    expect(ctorOptions().providers).toBeUndefined();
  });

  it('passes no registry for a graph without facade agents', async () => {
    const rawGraph = graph({
      name: 'raw',
      nodes: [{ id: 'worker', agentId: '00000000-0000-4000-8000-000000000002', reads: ['goal'], writes: 'out' }],
      edges: [],
    });

    await run(rawGraph, { goal: 'explain' });

    expect(ctorOptions().registry).toBeUndefined();
  });

  it('rejects a runner.registry override when the graph carries facade agents', async () => {
    const override = { registry: { loadAgent: vi.fn() } } as never;

    await expect(run(linearGraph(), { goal: 'explain' }, { runner: override })).rejects.toThrow(
      /inline agent\(\) definitions/,
    );
  });

  it('uses caller-supplied providers when given', async () => {
    const providers = { register: vi.fn() } as never;

    await run(linearGraph(), { goal: 'explain' }, { providers });

    expect(ctorOptions().providers).toBe(providers);
  });

  it('builds workflow state from the graph id and input', async () => {
    const g = linearGraph();

    await run(g, { goal: 'explain LLMs', constraints: ['short'] });

    const passedState = runnerCtor.mock.calls[0][1] as WorkflowState;
    expect(passedState.workflow_id).toBe(g.id);
    expect(passedState.goal).toBe('explain LLMs');
    expect(passedState.constraints).toEqual(['short']);
  });

  it('wires a persistState callback on the runner', async () => {
    await run(linearGraph(), { goal: 'explain' });

    expect(typeof ctorOptions().persistState).toBe('function');
  });

  it('accepts a prebuilt workflow state', async () => {
    const g = linearGraph();
    const prebuilt = state({ workflowId: g.id, goal: 'seeded', memory: { seed: 1 } });

    await run(g, prebuilt);

    const passedState = runnerCtor.mock.calls[0][1] as WorkflowState;
    expect(passedState.memory).toMatchObject({ seed: 1 });
  });

  it('forwards runner option overrides', async () => {
    const middleware = [{ name: 'm' }] as never;

    await run(linearGraph(), { goal: 'explain' }, { runner: { middleware } });

    expect(ctorOptions().middleware).toBe(middleware);
  });

  it('wires inline tool implementations onto the runner', async () => {
    const lookupOrder = tool({
      name: 'lookup_order',
      description: 'Fetch an order by id',
      parameters: z.object({ orderId: z.string() }),
      execute: () => 'order',
    });
    const worker = node({
      id: 'worker',
      agent: agent({ model: 'claude-sonnet-4-6', instructions: 'w' }),
      tools: [lookupOrder],
      writes: 'out',
    });
    const g = graph({ name: 'inline', nodes: [worker], edges: [] });

    await run(g, { goal: 'explain' });

    expect(ctorOptions().tools).toEqual([lookupOrder]);
  });

  it('merges inline tools with runner.tools without duplicating shared references', async () => {
    const lookupOrder = tool({
      name: 'lookup_order',
      description: 'Fetch an order by id',
      parameters: z.object({ orderId: z.string() }),
      execute: () => 'order',
    });
    const mcpResolver = { resolveTools: vi.fn() } as never;
    const worker = node({
      id: 'worker',
      agent: agent({ model: 'claude-sonnet-4-6', instructions: 'w' }),
      tools: [lookupOrder],
      writes: 'out',
    });
    const g = graph({ name: 'merge', nodes: [worker], edges: [] });

    await run(g, { goal: 'explain' }, { runner: { tools: [lookupOrder, mcpResolver] } });

    expect(ctorOptions().tools).toEqual([lookupOrder, mcpResolver]);
  });
});

describe('state', () => {
  it('builds a workflow state from authoring input', () => {
    const s = state({ workflowId: '00000000-0000-4000-8000-000000000001', goal: 'g' });

    expect(s.goal).toBe('g');
    expect(s.status).toBeDefined();
  });
});
