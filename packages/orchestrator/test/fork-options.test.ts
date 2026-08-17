/**
 * Tests for fork()'s option handling and fallbacks: the paths a happy-path
 * fork never reaches — resolution failures, budget refusal, gate limits,
 * predicate addressing, and the config a replay seeds itself from.
 */

import { describe, it, expect, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';

vi.mock('../src/agents/executors/agent/executor', () => ({
  executeAgent: vi.fn(async (agentId: string, _v: unknown, _t: unknown, attempt: number, opts: { nodeId?: string }) => {
    const nodeId = opts?.nodeId ?? agentId;
    return {
      id: uuidv4(),
      idempotency_key: `${nodeId}:${attempt}`,
      type: 'update_memory',
      payload: { updates: { [`${nodeId}_out`]: 'done' } },
      metadata: {
        node_id: nodeId,
        agent_id: agentId,
        timestamp: new Date(),
        attempt,
        model: 'claude-sonnet-4-6',
        token_usage: { inputTokens: 200_000, outputTokens: 200_000, totalTokens: 400_000 },
      },
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

import { fork } from '../src/replay/fork.js';
import { change } from '../src/replay/mutations.js';
import { ForkError } from '../src/replay/errors.js';
import { createGraph } from '../src/graph/graph.js';
import { createWorkflowState } from '../src/state/state.js';
import { GraphRunner } from '../src/execution/engine/graph-runner.js';
import { InMemoryEventLogWriter } from '../src/persistence/event-log.js';
import { InMemoryAgentRegistry, InMemoryPersistenceProvider } from '../src/persistence/in-memory.js';
import type { Graph } from '../src/graph/graph.js';
import type { WorkflowState } from '../src/state/state.js';

interface Recorded {
  graph: Graph;
  runId: string;
  eventLog: InMemoryEventLogWriter;
  registry: InMemoryAgentRegistry;
  persistence: InMemoryPersistenceProvider;
  state: WorkflowState;
}

async function record(
  input: Record<string, unknown> = {},
  extraNode = false,
): Promise<Recorded> {
  const registry = new InMemoryAgentRegistry();
  const mk = (n: string) => registry.register({
    name: n, model: 'claude-sonnet-4-6', provider: 'anthropic', systemPrompt: n,
  });
  const graph = createGraph({
    name: 'two-step',
    description: 'options fixture',
    nodes: [
      { id: 'research', type: 'agent', agentId: mk('R'), readKeys: ['goal'], writeKeys: ['research_out'] },
      { id: 'write', type: 'agent', agentId: mk('W'), readKeys: ['research_out'], writeKeys: ['write_out'] },
      ...(extraNode
        ? [{ id: 'polish', type: 'agent' as const, agentId: mk('P'), readKeys: ['write_out'], writeKeys: ['polish_out'] }]
        : []),
    ],
    edges: extraNode
      ? [{ source: 'research', target: 'write' }, { source: 'write', target: 'polish' }]
      : [{ source: 'research', target: 'write' }],
    startNode: 'research',
    endNodes: [extraNode ? 'polish' : 'write'],
  });

  const eventLog = new InMemoryEventLogWriter();
  const persistence = new InMemoryPersistenceProvider();
  await persistence.saveGraph(graph);
  const initial = createWorkflowState({ workflowId: graph.id, goal: 'g', ...input });
  const runner = new GraphRunner(graph, initial, {
    registry, eventLog, compactionInterval: 0,
    persistState: (s) => persistence.saveWorkflowSnapshot(s),
  });

  // A budget breach throws out of run() rather than returning a failed state,
  // and a breached run is exactly what some of these need to fork.
  let state: WorkflowState;
  try {
    state = await runner.run();
  } catch {
    state = (await persistence.loadLatestWorkflowState(initial.run_id))!;
  }

  return { graph, runId: initial.run_id, eventLog, registry, persistence, state };
}

describe('fork — graph resolution', () => {
  it('refuses a run the persistence provider does not have', async () => {
    const base = await record();

    await expect(fork(uuidv4(), {
      at: 'start',
      eventLog: base.eventLog,
      persistence: base.persistence,
    })).rejects.toThrow(/no such run in this persistence provider/);
  });

  it('refuses when the run references a graph that was never saved', async () => {
    const base = await record();
    const orphan = new InMemoryPersistenceProvider();
    await orphan.saveWorkflowRun({ ...base.state, workflow_id: uuidv4() });

    await expect(fork(base.runId, {
      at: 'start',
      eventLog: base.eventLog,
      persistence: orphan,
    })).rejects.toThrow(/cannot be forked by run id/);
  });
});

describe('fork — addressing', () => {
  it('accepts a predicate that halts the replay', async () => {
    const base = await record();

    const f = await fork(base.runId, {
      at: { where: ({ event }) => event.event_type === 'node_started' && event.node_id === 'write' },
      eventLog: base.eventLog,
      graph: base.graph,
      registry: base.registry,
    });

    expect(f.forkNodeId).toBe('write');
    expect(f.state?.status).toBe('completed');
  });

  it("defaults to 'failure' only when the base run failed", async () => {
    const base = await record();

    await expect(fork(base.runId, {
      eventLog: base.eventLog,
      graph: base.graph,
      registry: base.registry,
    })).rejects.toThrow(/no obvious fork point/);
  });

  it('records the variant into a caller-supplied log', async () => {
    const base = await record();
    const variantLog = new InMemoryEventLogWriter();

    const f = await fork(base.runId, {
      at: { beforeNode: 'write' },
      eventLog: base.eventLog,
      graph: base.graph,
      registry: base.registry,
      variantEventLog: variantLog,
    });

    expect(f.eventLog).toBe(variantLog);
    expect((await variantLog.loadEvents(f.runId)).length).toBeGreaterThan(0);
  });
});

describe('fork — seeded state', () => {
  it('carries the memory the base run was seeded with into the fork', async () => {
    const base = await record({ memory: { seeded_input: 'rec-42' } });

    const f = await fork(base.runId, {
      at: { beforeNode: 'write' },
      eventLog: base.eventLog,
      graph: base.graph,
      registry: base.registry,
    });

    expect(f.prefixState.memory.seeded_input).toBe('rec-42');
  });

  it('carries the run limits recorded at start', async () => {
    const base = await record({ maxIterations: 7, budgetUsd: 100 });

    const f = await fork(base.runId, {
      at: { beforeNode: 'write' },
      eventLog: base.eventLog,
      graph: base.graph,
      registry: base.registry,
    });

    expect(f.prefixState.max_iterations).toBe(7);
    expect(f.prefixState.budget_usd).toBe(100);
  });

  it('leaves memory alone when a patch changes nothing', async () => {
    const base = await record();

    const f = await fork(base.runId, {
      at: { beforeNode: 'write' },
      change: change.memory({}),
      eventLog: base.eventLog,
      graph: base.graph,
      registry: base.registry,
    });

    expect(f.state?.status).toBe('completed');
  });
});

describe('fork — production hygiene', () => {
  it('rejects a where predicate that halts inside a node execution', async () => {
    const base = await record();

    await expect(fork(base.runId, {
      at: { where: ({ event }) => event.event_type === 'action_dispatched' },
      eventLog: base.eventLog,
      graph: base.graph,
      registry: base.registry,
    })).rejects.toThrow(/inside a node's execution/);
  });

  it('defaults a persisted fork into the base run event log', async () => {
    const base = await record();

    const f = await fork(base.runId, {
      at: { beforeNode: 'write' },
      eventLog: base.eventLog,
      persistence: base.persistence,
      registry: base.registry,
    });

    expect(f.eventLog).toBe(base.eventLog);
    expect((await base.eventLog.loadEvents(f.runId)).length).toBeGreaterThan(0);
  });

  it('keeps an ephemeral fork out of the base log', async () => {
    const base = await record();
    const before = (await base.eventLog.loadEvents(base.runId)).length;

    const f = await fork(base.runId, {
      at: { beforeNode: 'write' },
      eventLog: base.eventLog,
      graph: base.graph,
      registry: base.registry,
    });

    expect(f.eventLog).not.toBe(base.eventLog);
    expect((await base.eventLog.loadEvents(base.runId)).length).toBe(before);
  });

  it('creates the run row before the first event lands in a durable log', async () => {
    const base = await record();

    // A relational log keys appends to the run row by foreign key, so the row
    // must exist first. The probe enforces the same ordering an FK would.
    const probe = new InMemoryEventLogWriter();
    const originalAppend = probe.append.bind(probe);
    let rowExistedAtFirstAppend: boolean | undefined;
    probe.append = async (event) => {
      rowExistedAtFirstAppend ??=
        (await base.persistence.loadWorkflowRun(event.run_id)) !== null;
      return originalAppend(event);
    };

    await fork(base.runId, {
      at: { beforeNode: 'write' },
      eventLog: base.eventLog,
      persistence: base.persistence,
      registry: base.registry,
      variantEventLog: probe,
    });

    expect(rowExistedAtFirstAppend).toBe(true);
  });
});

describe('fork — a log written before config was recorded', () => {
  it('falls back to schema defaults for every limit the log does not carry', async () => {
    const base = await record();
    const legacy = new InMemoryEventLogWriter();

    // `workflow_started` began carrying the run's config later than the rest
    // of the log format. Dropping it reproduces a log written before that, and
    // the fork has to seed itself from defaults rather than refuse.
    for (const e of await base.eventLog.loadEvents(base.runId)) {
      if (e.event_type === 'workflow_started') continue;
      const { id: _i, created_at: _c, ...rest } = e;
      await legacy.append(rest);
    }

    const f = await fork(base.runId, {
      at: { beforeNode: 'write' },
      eventLog: legacy,
      graph: base.graph,
      registry: base.registry,
    });

    expect(f.prefixState.goal).toBe('');
    expect(f.prefixState.max_retries).toBe(3);
    expect(f.prefixState.max_iterations).toBe(50);
    expect(f.prefixState.budget_usd).toBeUndefined();
    expect(f.state?.status).toBe('completed');
  });
});

describe('fork — snapshot source refusals', () => {
  it('refuses a node address on the snapshot source, listing the versions', async () => {
    const base = await record();

    await expect(fork(base.runId, {
      at: { beforeNode: 'write' },
      source: 'snapshot',
      persistence: base.persistence,
      registry: base.registry,
    })).rejects.toThrow(/Versions \d+\.\.\d+ are addressable/);
  });

  it('refuses when neither events nor a persistence provider are available', async () => {
    const base = await record();

    await expect(fork(base.runId, {
      at: 'start',
      graph: base.graph,
      eventLog: new InMemoryEventLogWriter(),
      registry: base.registry,
    })).rejects.toThrow(ForkError);
  });

  it('refuses a run with neither events nor snapshots', async () => {
    const empty = new InMemoryPersistenceProvider();

    await expect(fork(uuidv4(), {
      at: { version: 1 },
      source: 'snapshot',
      persistence: empty,
      graph: (await record()).graph,
    })).rejects.toThrow(/no events and no state snapshots/);
  });
});
