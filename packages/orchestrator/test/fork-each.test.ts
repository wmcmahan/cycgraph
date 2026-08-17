/**
 * Tests for forkEach and estimateSweep (src/replay/fork-each.ts): running one
 * fork per variant against a shared base run and address.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';

const agentOutputs = vi.hoisted(() => new Map<string, string>());
const executions = vi.hoisted(() => ({ count: 0 }));

vi.mock('../src/agents/executors/agent/executor', () => ({
  executeAgent: vi.fn(async (agentId: string, _view: unknown, _tools: unknown, attempt: number, opts: { nodeId?: string }) => {
    executions.count++;
    const nodeId = opts?.nodeId ?? agentId;
    return {
      id: uuidv4(),
      idempotency_key: `${nodeId}:${attempt}`,
      type: 'update_memory',
      payload: { updates: { [`${nodeId}_out`]: agentOutputs.get(agentId) ?? `${agentId}:default` } },
      metadata: { node_id: nodeId, agent_id: agentId, timestamp: new Date(), attempt },
    };
  }),
}));

vi.mock('@opentelemetry/api', () => ({
  trace: {
    getActiveSpan: () => undefined,
    getTracer: () => ({
      startActiveSpan: (_n: string, _o: unknown, fn: (s: unknown) => unknown) =>
        fn({ setAttribute: vi.fn(), setStatus: vi.fn(), recordException: vi.fn(), end: vi.fn() }),
    }),
  },
  isSpanContextValid: () => false,
  SpanStatusCode: { OK: 0, ERROR: 2 },
  context: {},
}));

import { forkEach, estimateSweep } from '../src/replay/fork-each.js';
import { change } from '../src/replay/mutations.js';
import { ForkError } from '../src/replay/errors.js';
import { createGraph } from '../src/graph/graph.js';
import { createWorkflowState } from '../src/state/state.js';
import { GraphRunner } from '../src/execution/engine/graph-runner.js';
import { InMemoryEventLogWriter } from '../src/persistence/event-log.js';
import { InMemoryAgentRegistry, InMemoryPersistenceProvider } from '../src/persistence/in-memory.js';
import type { Graph } from '../src/graph/graph.js';

interface Recorded {
  graph: Graph;
  runId: string;
  eventLog: InMemoryEventLogWriter;
  registry: InMemoryAgentRegistry;
  persistence: InMemoryPersistenceProvider;
}

async function recordBaseRun(): Promise<Recorded> {
  const registry = new InMemoryAgentRegistry();
  const research = registry.register({
    name: 'Research', model: 'claude-sonnet-4-6', provider: 'anthropic', systemPrompt: 'r',
  });
  const write = registry.register({
    name: 'Write', model: 'claude-sonnet-4-6', provider: 'anthropic', systemPrompt: 'w',
  });

  const graph = createGraph({
    name: 'sweep-base',
    description: 'base run for sweep tests',
    nodes: [
      { id: 'research', type: 'agent', agentId: research, readKeys: ['goal'], writeKeys: ['research_out'] },
      { id: 'write', type: 'agent', agentId: write, readKeys: ['research_out'], writeKeys: ['write_out'] },
    ],
    edges: [{ source: 'research', target: 'write' }],
    startNode: 'research',
    endNodes: ['write'],
  });

  const eventLog = new InMemoryEventLogWriter();
  const persistence = new InMemoryPersistenceProvider();
  await persistence.saveGraph(graph);

  const initial = createWorkflowState({ workflowId: graph.id, goal: 'compare variants' });
  await new GraphRunner(graph, initial, {
    registry,
    eventLog,
    compactionInterval: 0,
    persistState: (s) => persistence.saveWorkflowSnapshot(s),
  }).run();

  return { graph, runId: initial.run_id, eventLog, registry, persistence };
}

beforeEach(() => {
  agentOutputs.clear();
  executions.count = 0;
});

describe('forkEach', () => {
  it('returns one entry per variant, in declaration order', async () => {
    const base = await recordBaseRun();

    const sweep = await forkEach(base.runId, {
      at: { beforeNode: 'write' },
      variants: {
        stronger: change.model('write', 'claude-opus-5'),
        terse: change.prompt('write', 'be terse'),
        cold: change.temperature('write', 0),
      },
      eventLog: base.eventLog,
      graph: base.graph,
      registry: base.registry,
    });

    expect(sweep.variants.map(v => v.name)).toEqual(['stronger', 'terse', 'cold']);
  });

  it('runs every variant from the same fork point', async () => {
    const base = await recordBaseRun();

    const sweep = await forkEach(base.runId, {
      at: { beforeNode: 'write' },
      variants: { a: change.model('write', 'm1'), b: change.model('write', 'm2') },
      eventLog: base.eventLog,
      graph: base.graph,
      registry: base.registry,
    });

    const points = sweep.variants.map(v => v.samples[0].forkSequenceId);
    expect(new Set(points).size).toBe(1);
  });

  it('gives every variant its own run id', async () => {
    const base = await recordBaseRun();

    const sweep = await forkEach(base.runId, {
      at: { beforeNode: 'write' },
      variants: { a: change.model('write', 'm1'), b: change.model('write', 'm2') },
      eventLog: base.eventLog,
      graph: base.graph,
      registry: base.registry,
    });

    const ids = sweep.variants.map(v => v.samples[0].runId);
    expect(new Set(ids).size).toBe(2);
  });

  it('ties the variants together under one fork group', async () => {
    const base = await recordBaseRun();

    const sweep = await forkEach(base.runId, {
      at: { beforeNode: 'write' },
      variants: { a: change.model('write', 'm1'), b: change.model('write', 'm2') },
      eventLog: base.eventLog,
      persistence: base.persistence,
      registry: base.registry,
    });

    const rows = await Promise.all(
      sweep.variants.map(v => base.persistence.loadWorkflowRun(v.samples[0].runId)),
    );
    expect(rows.map(r => r?.fork_group_id)).toEqual([sweep.forkGroupId, sweep.forkGroupId]);
  });

  it('measures a bundle against its own parts in one pass', async () => {
    const base = await recordBaseRun();

    const sweep = await forkEach(base.runId, {
      at: { beforeNode: 'write' },
      variants: {
        model: change.model('write', 'claude-opus-5'),
        prompt: change.prompt('write', 'be terse'),
        both: [change.model('write', 'claude-opus-5'), change.prompt('write', 'be terse')],
      },
      eventLog: base.eventLog,
      graph: base.graph,
      registry: base.registry,
    });

    expect(sweep.variants.map(v => v.samples[0].changes.length)).toEqual([1, 1, 2]);
  });

  it('runs only the tail for each variant, never the prefix', async () => {
    const base = await recordBaseRun();
    executions.count = 0;

    await forkEach(base.runId, {
      at: { beforeNode: 'write' },
      variants: { a: change.model('write', 'm1'), b: change.model('write', 'm2') },
      eventLog: base.eventLog,
      graph: base.graph,
      registry: base.registry,
    });

    expect(executions.count).toBe(2);
  });

  it('keeps every sample when asked for more than one', async () => {
    const base = await recordBaseRun();

    const sweep = await forkEach(base.runId, {
      at: { beforeNode: 'write' },
      variants: { a: change.model('write', 'm1') },
      samples: 3,
      eventLog: base.eventLog,
      graph: base.graph,
      registry: base.registry,
    });

    expect(sweep.variants[0].samples).toHaveLength(3);
    expect(sweep.variants[0].completed).toBe(3);
  });

  it('records a failing variant without discarding the others', async () => {
    const base = await recordBaseRun();

    const sweep = await forkEach(base.runId, {
      at: { beforeNode: 'write' },
      variants: {
        good: change.model('write', 'claude-opus-5'),
        bad: change.model('nonexistent-node', 'claude-opus-5'),
      },
      eventLog: base.eventLog,
      graph: base.graph,
      registry: base.registry,
    });

    expect(sweep.variants[0].samples).toHaveLength(1);
    expect(sweep.variants[1].error?.message).toMatch(/no node 'nonexistent-node'/);
  });

  it('sums incurred spend across the sweep', async () => {
    const base = await recordBaseRun();

    const sweep = await forkEach(base.runId, {
      at: { beforeNode: 'write' },
      variants: { a: change.model('write', 'm1'), b: change.model('write', 'm2') },
      eventLog: base.eventLog,
      graph: base.graph,
      registry: base.registry,
    });

    const expected = sweep.variants.reduce((sum, v) => sum + v.meanCostUsd, 0);
    expect(sweep.totalCostUsd).toBeCloseTo(expected);
  });

  it('refuses a sweep with no variants', async () => {
    const base = await recordBaseRun();

    await expect(forkEach(base.runId, {
      at: { beforeNode: 'write' },
      variants: {},
      eventLog: base.eventLog,
      graph: base.graph,
      registry: base.registry,
    })).rejects.toThrow(ForkError);
  });
});

describe('forkEach — explain', () => {
  it('names every variant in the ranking', async () => {
    const base = await recordBaseRun();

    const sweep = await forkEach(base.runId, {
      at: { beforeNode: 'write' },
      variants: { stronger: change.model('write', 'm1'), terse: change.prompt('write', 'p') },
      eventLog: base.eventLog,
      graph: base.graph,
      registry: base.registry,
    });

    const text = sweep.explain();
    expect(text).toContain('stronger');
    expect(text).toContain('terse');
    expect(text).toContain('2 variant(s)');
  });

  it('reports completion counts rather than one status when sampling', async () => {
    const base = await recordBaseRun();

    const sweep = await forkEach(base.runId, {
      at: { beforeNode: 'write' },
      variants: { a: change.model('write', 'm1') },
      samples: 2,
      eventLog: base.eventLog,
      graph: base.graph,
      registry: base.registry,
    });

    expect(sweep.explain()).toContain('2/2 completed');
  });

  it('shows a failed variant with its reason', async () => {
    const base = await recordBaseRun();

    const sweep = await forkEach(base.runId, {
      at: { beforeNode: 'write' },
      variants: { bad: change.model('nope', 'm1') },
      eventLog: base.eventLog,
      graph: base.graph,
      registry: base.registry,
    });

    expect(sweep.explain()).toMatch(/bad\s+failed:/);
  });
});

describe('estimateSweep', () => {
  it('predicts spend without executing anything', async () => {
    const base = await recordBaseRun();
    executions.count = 0;

    const estimate = await estimateSweep(base.runId, {
      at: { beforeNode: 'write' },
      variants: { a: change.model('write', 'm1'), b: change.model('write', 'm2') },
      eventLog: base.eventLog,
      graph: base.graph,
      registry: base.registry,
    });

    expect(executions.count).toBe(0);
    expect(estimate.lines).toHaveLength(2);
  });

  it('multiplies the estimate by the sample count', async () => {
    const base = await recordBaseRun();

    const single = await estimateSweep(base.runId, {
      at: { beforeNode: 'write' },
      variants: { a: change.model('write', 'm1') },
      eventLog: base.eventLog,
      graph: base.graph,
      registry: base.registry,
    });
    const tripled = await estimateSweep(base.runId, {
      at: { beforeNode: 'write' },
      variants: { a: change.model('write', 'm1') },
      samples: 3,
      eventLog: base.eventLog,
      graph: base.graph,
      registry: base.registry,
    });

    expect(tripled.costUsd).toBeCloseTo(single.costUsd * 3);
  });

  it('surfaces a change that will not resolve before any money is spent', async () => {
    const base = await recordBaseRun();

    await expect(estimateSweep(base.runId, {
      at: { beforeNode: 'write' },
      variants: { bad: change.model('nope', 'm1') },
      eventLog: base.eventLog,
      graph: base.graph,
      registry: base.registry,
    })).rejects.toThrow(/no node 'nope'/);
  });
});
