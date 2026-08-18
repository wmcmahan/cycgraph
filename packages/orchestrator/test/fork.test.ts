/**
 * Tests for fork() (src/replay/fork.ts): replaying a recorded run's prefix,
 * applying changes, and executing the tail live. The agent executor is mocked
 * so the tail's "LLM calls" are deterministic and observable.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';

const agentOutputs = vi.hoisted(() => new Map<string, string>());

vi.mock('../src/agents/executors/agent/executor', () => ({
  executeAgent: vi.fn(async (agentId: string, _view: unknown, _tools: unknown, attempt: number, opts: { nodeId?: string }) => {
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

import { fork } from '../src/replay/fork.js';
import { defineTool } from '../src/tools/define-tool.js';
import { z } from 'zod';
import { change } from '../src/replay/mutations.js';
import { ForkError, SideEffectBlockedError } from '../src/replay/errors.js';
import { ForkPointError } from '../src/replay/fork-point.js';
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

function buildGraph(registry: InMemoryAgentRegistry): { graph: Graph; ids: Record<string, string> } {
  const research = registry.register({
    name: 'Research', model: 'claude-sonnet-4-6', provider: 'anthropic', systemPrompt: 'r',
  });
  const write = registry.register({
    name: 'Write', model: 'claude-sonnet-4-6', provider: 'anthropic', systemPrompt: 'w',
  });

  const graph = createGraph({
    name: 'research-and-write',
    description: 'base run for fork tests',
    nodes: [
      { id: 'research', type: 'agent', agentId: research, readKeys: ['goal'], writeKeys: ['research_out'] },
      { id: 'write', type: 'agent', agentId: write, readKeys: ['research_out'], writeKeys: ['write_out'] },
    ],
    edges: [{ source: 'research', target: 'write' }],
    startNode: 'research',
    endNodes: ['write'],
  });

  return { graph, ids: { research, write } };
}

async function recordBaseRun(): Promise<Recorded> {
  const registry = new InMemoryAgentRegistry();
  const { graph } = buildGraph(registry);
  const eventLog = new InMemoryEventLogWriter();
  const persistence = new InMemoryPersistenceProvider();
  await persistence.saveGraph(graph);

  const initial = createWorkflowState({ workflowId: graph.id, goal: 'explain forking' });
  const runner = new GraphRunner(graph, initial, {
    registry,
    eventLog,
    compactionInterval: 0,
    persistState: (s) => persistence.saveWorkflowSnapshot(s),
  });
  const state = await runner.run();

  return { graph, runId: initial.run_id, eventLog, registry, persistence, state };
}

beforeEach(() => {
  agentOutputs.clear();
});

const lookupTool = (result: string) => defineTool({
  name: 'lookup',
  description: 'looks something up',
  parameters: z.object({}),
  execute: () => result,
});

function toolGraph(registry: InMemoryAgentRegistry): Graph {
  const research = registry.register({
    name: 'Research', model: 'claude-sonnet-4-6', provider: 'anthropic', systemPrompt: 'r',
  });
  return createGraph({
    name: 'tool-then-agent',
    description: 'tool run for fork tests',
    nodes: [
      { id: 'research', type: 'agent', agentId: research, readKeys: ['goal'], writeKeys: ['research_out'] },
      { id: 'fetch', type: 'tool', toolId: 'lookup', tools: ['lookup'], readKeys: ['research_out'] },
    ],
    edges: [{ source: 'research', target: 'fetch' }],
    startNode: 'research',
    endNodes: ['fetch'],
  });
}

async function recordToolRun(): Promise<Recorded> {
  const registry = new InMemoryAgentRegistry();
  const graph = toolGraph(registry);
  const eventLog = new InMemoryEventLogWriter();
  const persistence = new InMemoryPersistenceProvider();
  await persistence.saveGraph(graph);

  const initial = createWorkflowState({ workflowId: graph.id, goal: 'fetch things' });
  const runner = new GraphRunner(graph, initial, {
    registry,
    eventLog,
    compactionInterval: 0,
    tools: [lookupTool('live result')],
    persistState: (s) => persistence.saveWorkflowSnapshot(s),
  });
  const state = await runner.run();
  return { graph, runId: initial.run_id, eventLog, registry, persistence, state };
}


describe('fork', () => {
  it('reproduces the base run when nothing changes', async () => {
    const base = await recordBaseRun();

    const f = await fork(base.runId, {
      at: { beforeNode: 'write' },
      eventLog: base.eventLog,
      graph: base.graph,
      registry: base.registry,
    });

    expect(f.state?.memory).toEqual(base.state.memory);
    expect(f.state?.status).toBe(base.state.status);
    expect(f.state?.visited_nodes).toEqual(base.state.visited_nodes);
  });

  it('replays the prefix without re-running its nodes', async () => {
    const base = await recordBaseRun();
    agentOutputs.set(base.graph.nodes[0].agent_id!, 'SHOULD NOT APPEAR');

    const f = await fork(base.runId, {
      at: { beforeNode: 'write' },
      eventLog: base.eventLog,
      graph: base.graph,
      registry: base.registry,
    });

    expect(f.state?.memory.research_out).toBe(base.state.memory.research_out);
  });

  it('runs the tail live so a changed agent produces a different result', async () => {
    const base = await recordBaseRun();
    agentOutputs.set(base.graph.nodes[1].agent_id!, 'rewritten');

    const f = await fork(base.runId, {
      at: { beforeNode: 'write' },
      eventLog: base.eventLog,
      graph: base.graph,
      registry: base.registry,
    });

    expect(f.state?.memory.write_out).toBe('rewritten');
    expect(base.state.memory.write_out).not.toBe('rewritten');
  });

  it('applies a memory patch to the forked prefix', async () => {
    const base = await recordBaseRun();

    const f = await fork(base.runId, {
      at: { beforeNode: 'write' },
      change: change.memory({ set: { research_out: 'patched notes' } }),
      eventLog: base.eventLog,
      graph: base.graph,
      registry: base.registry,
    });

    expect(f.state?.memory.research_out).toBe('patched notes');
  });

  it('deletes a memory key when asked', async () => {
    const base = await recordBaseRun();

    const f = await fork(base.runId, {
      at: { beforeNode: 'write' },
      change: change.memory({ delete: ['research_out'] }),
      eventLog: base.eventLog,
      graph: base.graph,
      registry: base.registry,
    });

    expect(f.state?.memory.research_out).toBeUndefined();
  });

  it('gives the variant its own run id and records the base as its parent', async () => {
    const base = await recordBaseRun();

    const f = await fork(base.runId, {
      at: { beforeNode: 'write' },
      eventLog: base.eventLog,
      graph: base.graph,
      registry: base.registry,
    });

    expect(f.runId).not.toBe(base.runId);
    expect(f.baseRunId).toBe(base.runId);
    expect(f.state?.run_id).toBe(f.runId);
  });

  it('reports the cost the tail incurred, not the prefix it inherited', async () => {
    const base = await recordBaseRun();

    const f = await fork(base.runId, {
      at: { beforeNode: 'write' },
      eventLog: base.eventLog,
      graph: base.graph,
      registry: base.registry,
    });

    expect(f.incurredCostUsd).toBe(
      (f.state?.total_cost_usd ?? 0) - f.prefixState.total_cost_usd,
    );
  });

  it('resolves the graph from persistence when none is passed', async () => {
    const base = await recordBaseRun();

    const f = await fork(base.runId, {
      at: { beforeNode: 'write' },
      eventLog: base.eventLog,
      persistence: base.persistence,
      registry: base.registry,
    });

    expect(f.state?.status).toBe('completed');
  });

  it('forks from the start and re-runs every node', async () => {
    const base = await recordBaseRun();
    agentOutputs.set(base.graph.nodes[0].agent_id!, 'fresh research');

    const f = await fork(base.runId, {
      at: 'start',
      eventLog: base.eventLog,
      graph: base.graph,
      registry: base.registry,
    });

    expect(f.state?.memory.research_out).toBe('fresh research');
    expect(f.state?.visited_nodes).toEqual(['research', 'write']);
  });
});

describe('fork — genesis and sequencing', () => {
  it('opens the variant log with a workflow_started carrying the fork metadata', async () => {
    const base = await recordBaseRun();

    const f = await fork(base.runId, {
      at: { beforeNode: 'write' },
      change: change.memory({ set: { research_out: 'patched' } }),
      eventLog: base.eventLog,
      graph: base.graph,
      registry: base.registry,
    });

    const events = await f.eventLog.loadEvents(f.runId);
    expect(events[0]).toMatchObject({
      sequence_id: 0,
      event_type: 'workflow_started',
      internal_payload: { forked_from: base.runId, fork_sequence_id: f.forkSequenceId },
    });
  });

  it('numbers live events above the genesis instead of colliding with it', async () => {
    const base = await recordBaseRun();

    const f = await fork(base.runId, {
      at: { beforeNode: 'write' },
      eventLog: base.eventLog,
      graph: base.graph,
      registry: base.registry,
    });

    const events = await f.eventLog.loadEvents(f.runId);
    const sequences = events.map(e => e.sequence_id);
    expect(sequences).toEqual([...new Set(sequences)]);
    expect(Math.min(...sequences.slice(1))).toBe(1);
  });

  it('anchors a checkpoint to the genesis so the variant recovers on its own', async () => {
    const base = await recordBaseRun();

    const f = await fork(base.runId, {
      at: { beforeNode: 'write' },
      eventLog: base.eventLog,
      graph: base.graph,
      registry: base.registry,
    });

    const checkpoint = await f.eventLog.loadCheckpoint(f.runId);
    expect(checkpoint?.sequence_id).toBe(0);
    expect(checkpoint?.state.run_id).toBe(f.runId);
  });

  it('drops the base run event-log high-water mark from the forked state', async () => {
    const base = await recordBaseRun();

    const f = await fork(base.runId, {
      at: { beforeNode: 'write' },
      eventLog: base.eventLog,
      graph: base.graph,
      registry: base.registry,
    });

    const checkpoint = await f.eventLog.loadCheckpoint(f.runId);
    expect(checkpoint?.state._last_event_sequence_id).toBeUndefined();
  });
});

describe('fork — agent changes', () => {
  it('swaps the model behind a node without touching the registry', async () => {
    const base = await recordBaseRun();
    const writeAgentId = base.graph.nodes[1].agent_id!;

    await fork(base.runId, {
      at: { beforeNode: 'write' },
      change: change.model('write', 'claude-haiku-4-5-20251001'),
      eventLog: base.eventLog,
      graph: base.graph,
      registry: base.registry,
    });

    expect((await base.registry.loadAgent(writeAgentId))?.model).toBe('claude-sonnet-4-6');
  });

  it('scopes an agent change to the node that names it', async () => {
    const base = await recordBaseRun();

    const f = await fork(base.runId, {
      at: 'start',
      change: change.prompt('write', 'be terse'),
      eventLog: base.eventLog,
      graph: base.graph,
      registry: base.registry,
    });

    expect(f.state?.status).toBe('completed');
    expect(base.graph.nodes[1].agent_id).not.toBe('write@fork');
  });

  it('composes two changes on one target onto a single agent clone', async () => {
    const base = await recordBaseRun();

    const f = await fork(base.runId, {
      at: { beforeNode: 'write' },
      change: [change.model('write', 'claude-opus-5'), change.temperature('write', 0)],
      eventLog: base.eventLog,
      graph: base.graph,
      registry: base.registry,
    });

    expect(f.changes).toHaveLength(2);
    expect(f.state?.status).toBe('completed');
  });

  it('refuses two changes that write the same target field', async () => {
    const base = await recordBaseRun();

    await expect(fork(base.runId, {
      at: { beforeNode: 'write' },
      change: [change.model('write', 'a'), change.model('write', 'b')],
      eventLog: base.eventLog,
      graph: base.graph,
      registry: base.registry,
    })).rejects.toThrow(/both write model:write/);
  });

  it('refuses a target naming a node the graph does not have', async () => {
    const base = await recordBaseRun();

    await expect(fork(base.runId, {
      at: { beforeNode: 'write' },
      change: change.model('wrtier', 'claude-opus-5'),
      eventLog: base.eventLog,
      graph: base.graph,
      registry: base.registry,
    })).rejects.toThrow(/no node 'wrtier'/);
  });
});

describe('fork — change callbacks', () => {
  it('hands the resolved fork point to a change function', async () => {
    const base = await recordBaseRun();
    const seen: string[] = [];

    await fork(base.runId, {
      at: { beforeNode: 'write' },
      change: (at) => {
        seen.push(at.node ?? 'none');
        return change.model(at.node!, 'claude-opus-5');
      },
      eventLog: base.eventLog,
      graph: base.graph,
      registry: base.registry,
    });

    expect(seen).toEqual(['write']);
  });

  it('persists what the callback produced, not the callback', async () => {
    const base = await recordBaseRun();

    const f = await fork(base.runId, {
      at: { beforeNode: 'write' },
      change: (at) => change.model(at.node!, 'claude-opus-5'),
      eventLog: base.eventLog,
      graph: base.graph,
      registry: base.registry,
    });

    const events = await f.eventLog.loadEvents(f.runId);
    expect(events[0].internal_payload?.fork_mutations).toEqual([
      { kind: 'model', target: 'write', model: 'claude-opus-5' },
    ]);
  });
});

describe('fork — refusals', () => {
  it('refuses a run with no recorded events and names the cause', async () => {
    const base = await recordBaseRun();

    await expect(fork(uuidv4(), {
      at: 'start',
      source: 'events',
      eventLog: base.eventLog,
      graph: base.graph,
    })).rejects.toThrow(/runRecorded\(\) does that, and run\(\) does not/);
  });

  it('refuses a completed run with no fork point given', async () => {
    const base = await recordBaseRun();

    await expect(fork(base.runId, {
      eventLog: base.eventLog,
      graph: base.graph,
      registry: base.registry,
    })).rejects.toThrow(ForkError);
  });

  it('refuses an address inside a node execution', async () => {
    const base = await recordBaseRun();
    const events = await base.eventLog.loadEvents(base.runId);
    const midGroup = events.find(e => e.event_type === 'action_dispatched')!;

    await expect(fork(base.runId, {
      at: { sequence: midGroup.sequence_id },
      eventLog: base.eventLog,
      graph: base.graph,
      registry: base.registry,
    })).rejects.toThrow(ForkPointError);
  });

  it('refuses when neither a graph nor a persistence provider is given', async () => {
    const base = await recordBaseRun();

    await expect(fork(base.runId, {
      at: 'start',
      eventLog: base.eventLog,
    })).rejects.toThrow(/pass either a 'graph' or a 'persistence' provider/);
  });
});

describe('fork — observability', () => {
  it('uses a caller-supplied run id so a recorder can open before the tail', async () => {
    const base = await recordBaseRun();
    const runId = uuidv4();

    const f = await fork(base.runId, {
      at: { beforeNode: 'write' },
      runId,
      eventLog: base.eventLog,
      graph: base.graph,
      registry: base.registry,
    });

    expect(f.runId).toBe(runId);
    expect(f.state?.run_id).toBe(runId);
  });

  it('records the caller run id in the variant log genesis', async () => {
    const base = await recordBaseRun();
    const runId = uuidv4();

    const f = await fork(base.runId, {
      at: { beforeNode: 'write' },
      runId,
      eventLog: base.eventLog,
      graph: base.graph,
      registry: base.registry,
    });

    const events = await f.eventLog.loadEvents(runId);
    expect(events[0]?.run_id).toBe(runId);
  });
});

describe('fork — dry run', () => {
  it('resolves the fork without executing the tail', async () => {
    const base = await recordBaseRun();

    const f = await fork(base.runId, {
      at: { beforeNode: 'write' },
      change: change.model('write', 'claude-opus-5'),
      eventLog: base.eventLog,
      graph: base.graph,
      registry: base.registry,
      dryRun: true,
    });

    expect(f.state).toBeNull();
    expect(f.forkNodeId).toBe('write');
    expect(await f.eventLog.loadEvents(f.runId)).toEqual([]);
  });

  it('reports the resolved point and changes', async () => {
    const base = await recordBaseRun();

    const f = await fork(base.runId, {
      at: { beforeNode: 'write' },
      change: change.model('write', 'claude-opus-5'),
      eventLog: base.eventLog,
      graph: base.graph,
      registry: base.registry,
      dryRun: true,
    });

    expect(f.explain()).toContain("before 'write' execution 1");
    expect(f.explain()).toContain('claude-opus-5');
    expect(f.explain()).toContain('dry run');
  });
});

describe('fork — explain', () => {
  it('names the fork point, the path, and the tail cost', async () => {
    const base = await recordBaseRun();
    agentOutputs.set(base.graph.nodes[1].agent_id!, 'rewritten');

    const f = await fork(base.runId, {
      at: { beforeNode: 'write' },
      change: change.model('write', 'claude-opus-5'),
      eventLog: base.eventLog,
      graph: base.graph,
      registry: base.registry,
    });

    const text = f.explain();
    expect(text).toContain(`fork ${f.runId.slice(0, 6)}`);
    expect(text).toContain('research → write');
    expect(text).toContain('incurred');
  });

  it('marks changed memory keys', async () => {
    const base = await recordBaseRun();
    agentOutputs.set(base.graph.nodes[1].agent_id!, 'rewritten');

    const f = await fork(base.runId, {
      at: { beforeNode: 'write' },
      eventLog: base.eventLog,
      graph: base.graph,
      registry: base.registry,
    });

    expect(f.explain()).toContain('~write_out');
  });
});

describe('fork — side effects', () => {
  it('serves a tool node from the recording instead of calling it again', async () => {
    const base = await recordToolRun();

    const f = await fork(base.runId, {
      at: { beforeNode: 'fetch' },
      eventLog: base.eventLog,
      graph: base.graph,
      registry: base.registry,
    });

    expect(f.state?.memory.fetch_result).toBe(base.state.memory.fetch_result);
    expect(f.suppressedEffects).toContainEqual({
      nodeId: 'fetch',
      kind: 'tool',
      reason: 'served from the recording, inputs unchanged',
    });
  });

  it("blocks a tool node outright under policy 'block'", async () => {
    const base = await recordToolRun();

    await expect(fork(base.runId, {
      at: { beforeNode: 'fetch' },
      eventLog: base.eventLog,
      graph: base.graph,
      registry: base.registry,
      policy: { sideEffects: 'block' },
    })).rejects.toThrow(SideEffectBlockedError);
  });

  it('lets a named node through when explicitly allowed', async () => {
    const base = await recordToolRun();

    const f = await fork(base.runId, {
      at: { beforeNode: 'fetch' },
      eventLog: base.eventLog,
      graph: base.graph,
      registry: base.registry,
      policy: { sideEffects: { allow: ['fetch'] } },
      runner: {
        tools: [lookupTool('refetched')],
      },
    });

    expect(f.state?.memory.fetch_result).toBe('refetched');
    expect(f.suppressedEffects).toEqual([]);
  });
});

describe('fork — recovery of a variant', () => {
  it('recovers the variant through the ordinary recovery path', async () => {
    const base = await recordBaseRun();

    const f = await fork(base.runId, {
      at: { beforeNode: 'write' },
      change: change.memory({ set: { research_out: 'patched notes' } }),
      eventLog: base.eventLog,
      graph: base.graph,
      registry: base.registry,
    });

    const recovered = await GraphRunner.recover(base.graph, f.runId, f.eventLog, {
      registry: base.registry,
    });

    expect(recovered['state'].memory).toEqual(f.state?.memory);
    expect(recovered['state'].status).toBe('completed');
  });

  it('does not skip a node when a resumed variant carries no foreign high-water mark', async () => {
    const base = await recordBaseRun();

    const f = await fork(base.runId, {
      at: { beforeNode: 'write' },
      eventLog: base.eventLog,
      graph: base.graph,
      registry: base.registry,
    });

    const checkpoint = await f.eventLog.loadCheckpoint(f.runId);
    const resumed = new GraphRunner(base.graph, checkpoint!.state, {
      registry: base.registry,
      eventLog: f.eventLog,
      compactionInterval: 0,
    });
    const state = await resumed.run();

    expect(state.visited_nodes).toContain('write');
    expect(state.memory.write_out).toBeDefined();
  });
});

describe('fork — lineage', () => {
  it('records the variant as a counterfactual of its parent', async () => {
    const base = await recordBaseRun();

    const f = await fork(base.runId, {
      at: { beforeNode: 'write' },
      change: change.model('write', 'claude-opus-5'),
      eventLog: base.eventLog,
      persistence: base.persistence,
      registry: base.registry,
    });

    expect(await base.persistence.loadWorkflowRun(f.runId)).toMatchObject({
      run_kind: 'counterfactual',
      parent_run_id: base.runId,
      fork_sequence_id: f.forkSequenceId,
      fork_mutations: [{ kind: 'model', target: 'write', model: 'claude-opus-5' }],
    });
  });

  it('leaves the base run marked as primary', async () => {
    const base = await recordBaseRun();

    await fork(base.runId, {
      at: { beforeNode: 'write' },
      eventLog: base.eventLog,
      persistence: base.persistence,
      registry: base.registry,
    });

    expect(await base.persistence.loadWorkflowRun(base.runId)).toMatchObject({
      run_kind: 'primary',
      parent_run_id: null,
    });
  });

  it('keeps lineage through the tail own state persists', async () => {
    const base = await recordBaseRun();

    const f = await fork(base.runId, {
      at: 'start',
      eventLog: base.eventLog,
      persistence: base.persistence,
      registry: base.registry,
    });

    const row = await base.persistence.loadWorkflowRun(f.runId);
    expect(row?.parent_run_id).toBe(base.runId);
    expect(row?.status).toBe('completed');
  });

  it('groups a variant into a sweep when given a group id', async () => {
    const base = await recordBaseRun();
    const groupId = uuidv4();

    const f = await fork(base.runId, {
      at: { beforeNode: 'write' },
      eventLog: base.eventLog,
      persistence: base.persistence,
      registry: base.registry,
      forkGroupId: groupId,
    });

    expect((await base.persistence.loadWorkflowRun(f.runId))?.fork_group_id).toBe(groupId);
  });

  it('stays ephemeral when no persistence is given', async () => {
    const base = await recordBaseRun();

    const f = await fork(base.runId, {
      at: { beforeNode: 'write' },
      eventLog: base.eventLog,
      graph: base.graph,
      registry: base.registry,
    });

    expect(await base.persistence.loadWorkflowRun(f.runId)).toBeNull();
  });
});

describe('fork — snapshot source', () => {
  it('forks from a persisted snapshot with no event log at all', async () => {
    const base = await recordBaseRun();
    const history = await base.persistence.loadWorkflowStateHistory(base.runId);
    const version = history[1].version;

    const f = await fork(base.runId, {
      at: { version },
      source: 'snapshot',
      persistence: base.persistence,
      registry: base.registry,
    });

    expect(f.state?.status).toBe('completed');
    expect(f.baseState.run_id).toBe(base.runId);
  });

  it('re-runs the node the snapshot was sitting on, and says so', async () => {
    const base = await recordBaseRun();
    const history = await base.persistence.loadWorkflowStateHistory(base.runId);
    const version = history[history.length - 1].version;

    const f = await fork(base.runId, {
      at: { version },
      source: 'snapshot',
      persistence: base.persistence,
      registry: base.registry,
      dryRun: true,
    });

    expect(f.explain()).toContain('re-running');
  });

  it('refuses a node address on the snapshot source', async () => {
    const base = await recordBaseRun();

    await expect(fork(base.runId, {
      at: { beforeNode: 'write' },
      source: 'snapshot',
      persistence: base.persistence,
      registry: base.registry,
    })).rejects.toThrow(/only be addressed by \{ version \}/);
  });

  it('refuses a version the run never reached', async () => {
    const base = await recordBaseRun();

    await expect(fork(base.runId, {
      at: { version: 999 },
      source: 'snapshot',
      persistence: base.persistence,
      registry: base.registry,
    })).rejects.toThrow(/no state snapshot at version 999/);
  });

  it('refuses a version address on the event source', async () => {
    const base = await recordBaseRun();

    await expect(fork(base.runId, {
      at: { version: 1 },
      eventLog: base.eventLog,
      graph: base.graph,
      registry: base.registry,
    })).rejects.toThrow(/addresses a persisted state snapshot/);
  });

  it('falls back to snapshots when the log was compacted away', async () => {
    const base = await recordBaseRun();
    const emptyLog = new InMemoryEventLogWriter();
    const history = await base.persistence.loadWorkflowStateHistory(base.runId);

    const f = await fork(base.runId, {
      at: { version: history[history.length - 1].version },
      eventLog: emptyLog,
      persistence: base.persistence,
      registry: base.registry,
    });

    expect(f.state?.status).toBe('completed');
  });

  it('prefers events over snapshots when both are available', async () => {
    const base = await recordBaseRun();

    const f = await fork(base.runId, {
      at: { beforeNode: 'write' },
      eventLog: base.eventLog,
      persistence: base.persistence,
      registry: base.registry,
    });

    expect(f.forkNodeId).toBe('write');
  });
});

describe('fork — execution-time changes', () => {
  it('substitutes a node output instead of executing it', async () => {
    const base = await recordBaseRun();
    agentOutputs.set(base.graph.nodes[1].agent_id!, 'SHOULD NOT APPEAR');

    const f = await fork(base.runId, {
      at: { beforeNode: 'write' },
      change: change.output('write', { write_out: 'handwritten' }),
      eventLog: base.eventLog,
      graph: base.graph,
      registry: base.registry,
    });

    expect(f.state?.memory.write_out).toBe('handwritten');
  });

  it('substitutes a tool result under the node result key', async () => {
    const base = await recordToolRun();

    const f = await fork(base.runId, {
      at: { beforeNode: 'fetch' },
      change: change.tool('fetch', 'substituted payload'),
      eventLog: base.eventLog,
      graph: base.graph,
      registry: base.registry,
    });

    expect(f.state?.memory.fetch_result).toBe('substituted payload');
  });

  it('overrides a tool node ahead of the side-effect guard', async () => {
    const base = await recordToolRun();

    const f = await fork(base.runId, {
      at: { beforeNode: 'fetch' },
      change: change.tool('fetch', 'substituted payload'),
      eventLog: base.eventLog,
      graph: base.graph,
      registry: base.registry,
      policy: { sideEffects: 'block' },
    });

    expect(f.state?.status).toBe('completed');
    expect(f.suppressedEffects).toEqual([]);
  });

  it('grants the node the keys a substituted output claims it wrote', async () => {
    const base = await recordBaseRun();

    const f = await fork(base.runId, {
      at: { beforeNode: 'write' },
      // `score` is nowhere in the write node's grants: the substitution is
      // what authorizes it.
      change: change.output('write', { score: 0.95 }),
      eventLog: base.eventLog,
      graph: base.graph,
      registry: base.registry,
    });

    expect(f.state?.status).toBe('completed');
    expect(f.state?.memory.score).toBe(0.95);
  });

  it('leaves the caller graph write keys untouched', async () => {
    const base = await recordBaseRun();
    const before = [...base.graph.nodes[1].write_keys];

    await fork(base.runId, {
      at: { beforeNode: 'write' },
      change: change.output('write', { score: 0.95 }),
      eventLog: base.eventLog,
      graph: base.graph,
      registry: base.registry,
    });

    expect(base.graph.nodes[1].write_keys).toEqual(before);
  });

  it('refuses a substituted output on a node the graph does not have', async () => {
    const base = await recordBaseRun();

    await expect(fork(base.runId, {
      at: { beforeNode: 'write' },
      change: change.output('nope', { score: 1 }),
      eventLog: base.eventLog,
      graph: base.graph,
      registry: base.registry,
    })).rejects.toThrow(/no node 'nope'/);
  });

  it('refuses an output and a tool change on the same node', async () => {
    const base = await recordToolRun();

    await expect(fork(base.runId, {
      at: { beforeNode: 'fetch' },
      change: [change.output('fetch', { x: 1 }), change.tool('fetch', 'y')],
      eventLog: base.eventLog,
      graph: base.graph,
      registry: base.registry,
    })).rejects.toThrow(/both write output:fetch/);
  });
});

describe('fork — human response', () => {
  async function recordGatedRun(): Promise<Recorded> {
    const registry = new InMemoryAgentRegistry();
    const research = registry.register({
      name: 'Research', model: 'claude-sonnet-4-6', provider: 'anthropic', systemPrompt: 'r',
    });
    const write = registry.register({
      name: 'Write', model: 'claude-sonnet-4-6', provider: 'anthropic', systemPrompt: 'w',
    });
    const graph = createGraph({
      name: 'gated',
      description: 'an approval gate between two agents',
      nodes: [
        { id: 'research', type: 'agent', agentId: research, readKeys: ['goal'], writeKeys: ['research_out'] },
        {
          id: 'approve',
          type: 'approval',
          readKeys: ['research_out'],
          approvalConfig: { promptMessage: 'Ship it?' },
        },
        { id: 'write', type: 'agent', agentId: write, readKeys: ['research_out'], writeKeys: ['write_out'] },
      ],
      edges: [
        { source: 'research', target: 'approve' },
        { source: 'approve', target: 'write' },
      ],
      startNode: 'research',
      endNodes: ['write'],
    });

    const eventLog = new InMemoryEventLogWriter();
    const persistence = new InMemoryPersistenceProvider();
    await persistence.saveGraph(graph);
    const initial = createWorkflowState({ workflowId: graph.id, goal: 'gated run' });
    const state = await new GraphRunner(graph, initial, {
      registry, eventLog, compactionInterval: 0,
      persistState: (s) => persistence.saveWorkflowSnapshot(s),
    }).run();

    return { graph, runId: initial.run_id, eventLog, registry, persistence, state };
  }

  it('leaves the tail waiting at a gate when no answer is given', async () => {
    const base = await recordGatedRun();
    expect(base.state.status).toBe('waiting');

    const f = await fork(base.runId, {
      at: { beforeNode: 'approve' },
      eventLog: base.eventLog,
      graph: base.graph,
      registry: base.registry,
    });

    expect(f.state?.status).toBe('waiting');
  });

  it('answers the gate and carries the run past it', async () => {
    const base = await recordGatedRun();

    const f = await fork(base.runId, {
      at: { beforeNode: 'approve' },
      change: change.humanResponse('approved'),
      eventLog: base.eventLog,
      graph: base.graph,
      registry: base.registry,
    });

    expect(f.state?.status).toBe('completed');
    expect(f.state?.memory.write_out).toBeDefined();
  });

  it('applies memory updates supplied with the answer', async () => {
    const base = await recordGatedRun();

    const f = await fork(base.runId, {
      at: { beforeNode: 'approve' },
      change: change.humanResponse('approved', { memoryUpdates: { reviewer_note: 'looks fine' } }),
      eventLog: base.eventLog,
      graph: base.graph,
      registry: base.registry,
    });

    expect(f.state?.memory.reviewer_note).toBe('looks fine');
  });

  it('records the rejection path when the answer is no', async () => {
    const base = await recordGatedRun();

    const f = await fork(base.runId, {
      at: { beforeNode: 'approve' },
      change: change.humanResponse('rejected'),
      eventLog: base.eventLog,
      graph: base.graph,
      registry: base.registry,
    });

    expect(f.state?.status).not.toBe('waiting');
    expect(f.state?.memory.write_out).toBeUndefined();
  });
});

describe('fork — accepting a recorded run', () => {
  it('reads the run id, log, persistence and registry off a recorded run', async () => {
    const base = await recordBaseRun();

    const f = await fork({
      runId: base.runId,
      eventLog: base.eventLog,
      persistence: base.persistence,
      registry: base.registry,
    }, { at: { beforeNode: 'write' } });

    expect(f.baseRunId).toBe(base.runId);
    expect(f.state?.status).toBe('completed');
  });

  it('lets an explicit option override the recorded run handle', async () => {
    const base = await recordBaseRun();
    const variantLog = new InMemoryEventLogWriter();

    const f = await fork({
      runId: base.runId,
      eventLog: base.eventLog,
      persistence: base.persistence,
      registry: base.registry,
    }, { at: { beforeNode: 'write' }, variantEventLog: variantLog });

    expect(f.eventLog).toBe(variantLog);
  });

  it('resolves agents that exist only in the run-scoped registry', async () => {
    const base = await recordBaseRun();

    const f = await fork({
      runId: base.runId,
      eventLog: base.eventLog,
      persistence: base.persistence,
      registry: base.registry,
    }, {
      at: { beforeNode: 'write' },
      change: change.prompt('write', 'be terse'),
    });

    expect(f.state?.status).toBe('completed');
  });
});

describe('fork — failed tails leave no orphans', () => {
  it('marks the persisted row failed when the tail throws', async () => {
    const base = await recordToolRun();

    await expect(fork(base.runId, {
      at: { beforeNode: 'fetch' },
      eventLog: base.eventLog,
      persistence: base.persistence,
      registry: base.registry,
      policy: { sideEffects: 'block' },
    })).rejects.toThrow(SideEffectBlockedError);

    const rows = await base.persistence.listWorkflowRuns({ limit: 10 });
    const orphan = rows.find(r => r.run_kind === 'counterfactual');
    expect(orphan?.status).toBe('failed');
  });
});

describe('fork — several gates in one tail', () => {
  async function recordTwoGateRun(): Promise<Recorded> {
    const registry = new InMemoryAgentRegistry();
    const write = registry.register({
      name: 'Write', model: 'claude-sonnet-4-6', provider: 'anthropic', systemPrompt: 'w',
    });
    const graph = createGraph({
      name: 'double-gated',
      description: 'two approval gates in sequence',
      nodes: [
        { id: 'draft', type: 'agent', agentId: write, readKeys: ['goal'], writeKeys: ['draft_out'] },
        { id: 'gate_one', type: 'approval', approvalConfig: { promptMessage: 'First?' } },
        { id: 'gate_two', type: 'approval', approvalConfig: { promptMessage: 'Second?' } },
        { id: 'publish', type: 'agent', agentId: write, readKeys: ['draft_out'], writeKeys: ['publish_out'] },
      ],
      edges: [
        { source: 'draft', target: 'gate_one' },
        { source: 'gate_one', target: 'gate_two' },
        { source: 'gate_two', target: 'publish' },
      ],
      startNode: 'draft',
      endNodes: ['publish'],
    });

    const eventLog = new InMemoryEventLogWriter();
    const persistence = new InMemoryPersistenceProvider();
    await persistence.saveGraph(graph);
    const initial = createWorkflowState({ workflowId: graph.id, goal: 'two gates' });
    const runner = new GraphRunner(graph, initial, {
      registry, eventLog, compactionInterval: 0,
      persistState: (s) => persistence.saveWorkflowSnapshot(s),
    });

    // Answer both gates the way the engine's HITL path does, so the recording
    // is a completed run for the fork to replay.
    let state = await runner.run();
    for (let i = 0; state.status === 'waiting' && i < 5; i++) {
      runner.applyHumanResponse({ decision: 'approved' });
      state = await runner.run();
    }

    return { graph, runId: initial.run_id, eventLog, registry, persistence, state };
  }

  it('answers every gate the tail reaches, not only the first', async () => {
    const base = await recordTwoGateRun();
    expect(base.state.status).toBe('completed');

    const f = await fork(base.runId, {
      at: 'start',
      change: change.humanResponse('approved'),
      eventLog: base.eventLog,
      graph: base.graph,
      registry: base.registry,
    });

    expect(f.state?.status).toBe('completed');
    expect(f.state?.visited_nodes).toEqual(['draft', 'gate_one', 'gate_two', 'publish']);
  });

  it('answers gates through the environment reviewer too', async () => {
    const base = await recordTwoGateRun();
    const questions: string[] = [];

    const f = await fork(base.runId, {
      at: 'start',
      eventLog: base.eventLog,
      graph: base.graph,
      registry: base.registry,
      hitl: async (question) => {
        questions.push(question);
        return { decision: 'approved' };
      },
    });

    expect(f.state?.status).toBe('completed');
    expect(questions).toHaveLength(2);
  });
});
