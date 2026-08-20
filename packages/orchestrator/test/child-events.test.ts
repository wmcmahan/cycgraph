/**
 * Tests for subgraph child-event threading (execution/coordination/child-events.ts):
 * child execution recorded inline in the parent's log, parent replay unaffected,
 * child boundaries listed but not yet addressable.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { GraphRunner } from '../src/execution/engine/graph-runner.js';
import { InMemoryEventLogWriter } from '../src/persistence/event-log.js';
import { InMemoryAgentRegistry } from '../src/persistence/in-memory.js';
import { defineTool } from '../src/tools/define-tool.js';
import { childEventLogWriter } from '../src/execution/coordination/child-events.js';
import { childForkPoints, forkPoints, planForkPoint } from '../src/replay/fork-point.js';
import { replayEvents } from '../src/replay/replay-events.js';
import { fork } from '../src/replay/fork.js';
import { canonicalEquals } from '../src/replay/canonical.js';
import { createWorkflowState } from '../src/state/state.js';
import type { Graph, GraphNode } from '../src/graph/graph.js';
import type { NewWorkflowEvent, WorkflowEvent } from '../src/persistence/event.js';

const POLICY = { max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 0, max_backoff_ms: 0 } as const;

function toolNode(id: string, toolName: string): GraphNode {
  return {
    id,
    type: 'tool',
    tool_id: toolName,
    tools: [{ type: 'custom', name: toolName }],
    read_keys: ['*'],
    write_keys: ['*'],
    failure_policy: POLICY,
    requires_compensation: false,
  } as GraphNode;
}

function marker(name: string) {
  return defineTool({
    name,
    description: `Marks that ${name} ran.`,
    parameters: z.object({}),
    execute: () => ({ ran: name }),
  });
}

const CHILD_GRAPH: Graph = {
  id: 'child-graph',
  name: 'child',
  description: 'Two tool steps.',
  nodes: [toolNode('step-a', 'mark_a'), toolNode('step-b', 'mark_b')],
  edges: [{ id: uuidv4(), source: 'step-a', target: 'step-b', condition: { type: 'always' } }],
  start_node: 'step-a',
  end_nodes: ['step-b'],
} as Graph;

const PARENT_ID = uuidv4();

function parentGraph(): Graph {
  return {
    id: PARENT_ID,
    name: 'parent',
    description: 'Tool, subgraph, tool.',
    nodes: [
      toolNode('prep', 'mark_prep'),
      {
        id: 'sub',
        type: 'subgraph',
        subgraph_config: {
          subgraph_id: 'child-graph',
          input_mapping: {},
          output_mapping: { 'step-b_result': 'child_output' },
          max_iterations: 50,
        },
        read_keys: ['*'],
        write_keys: ['*'],
        failure_policy: POLICY,
        requires_compensation: false,
      } as GraphNode,
      toolNode('after', 'mark_after'),
    ],
    edges: [
      { id: uuidv4(), source: 'prep', target: 'sub', condition: { type: 'always' } },
      { id: uuidv4(), source: 'sub', target: 'after', condition: { type: 'always' } },
    ],
    start_node: 'prep',
    end_nodes: ['after'],
  } as Graph;
}

const TOOLS = [marker('mark_prep'), marker('mark_a'), marker('mark_b'), marker('mark_after')];

async function runParent() {
  const eventLog = new InMemoryEventLogWriter();
  const graph = parentGraph();
  const state = createWorkflowState({ workflowId: graph.id, goal: 'thread child events' });
  const runner = new GraphRunner(graph, state, {
    eventLog,
    compactionInterval: 0,
    loadGraphFn: async (id) => (id === 'child-graph' ? CHILD_GRAPH : null),
    tools: TOOLS,
  });
  const finalState = await runner.run();
  const events = await eventLog.loadEvents(finalState.run_id);
  return { eventLog, graph, finalState, events, seedRunId: finalState.run_id };
}

describe('childEventLogWriter', () => {
  const collect = () => {
    const seen: Array<{ type: string; opts: Record<string, unknown> }> = [];
    const sink = (type: string, opts: Record<string, unknown>) => seen.push({ type, opts });
    return { seen, writer: childEventLogWriter(sink as never, 'sub') };
  };

  const childEvent = (overrides: Partial<NewWorkflowEvent>): NewWorkflowEvent => ({
    run_id: 'c0ffee00-0000-4000-8000-000000000001',
    sequence_id: 7,
    event_type: 'node_started',
    ...overrides,
  });

  it('translates plain event types to their child counterparts', async () => {
    const { seen, writer } = collect();

    await writer.append(childEvent({ event_type: 'workflow_started' }));
    await writer.append(childEvent({ event_type: 'node_started', node_id: 'step-a' }));

    expect(seen.map((entry) => entry.type)).toEqual(['child_workflow_started', 'child_node_started']);
    expect(seen[1]!.opts.node_id).toBe('sub/step-a');
  });

  it('drops state_persisted markers', async () => {
    const { seen, writer } = collect();

    await writer.append(childEvent({ event_type: 'state_persisted' }));

    expect(seen).toEqual([]);
  });

  it('stamps the authoring run id and preserves it across nesting hops', async () => {
    const { seen, writer } = collect();

    await writer.append(childEvent({ event_type: 'node_started', node_id: 'step-a' }));
    await writer.append(childEvent({
      event_type: 'child_node_started',
      node_id: 'inner/leaf',
      internal_payload: { _child_run_id: 'grandchild-run' },
    }));

    expect((seen[0]!.opts.internal_payload as Record<string, unknown>)._child_run_id)
      .toBe('c0ffee00-0000-4000-8000-000000000001');
    expect(seen[1]!.opts.node_id).toBe('sub/inner/leaf');
    expect((seen[1]!.opts.internal_payload as Record<string, unknown>)._child_run_id)
      .toBe('grandchild-run');
  });

  it('refuses checkpoints and compaction by doing nothing', async () => {
    const { writer } = collect();

    await writer.checkpoint('run', 3, {} as never);
    expect(await writer.compact('run', 3)).toBe(0);
    expect(await writer.loadCheckpoint('run')).toBeNull();
    expect(await writer.loadEvents('run')).toEqual([]);
  });
});

describe('subgraph child events in the parent log', () => {
  it('records the child execution namespaced inside the subgraph node group', async () => {
    const { events } = await runParent();

    const childStarts = events.filter((e) => e.event_type === 'child_node_started');
    expect(childStarts.map((e) => e.node_id)).toEqual(['sub/step-a', 'sub/step-b']);

    const started = events.find((e) => e.event_type === 'child_workflow_started');
    expect(started?.node_id).toBe('sub');

    const subStart = events.find((e) => e.event_type === 'node_started' && e.node_id === 'sub')!;
    const subAction = events.find((e) => e.event_type === 'action_dispatched' && e.node_id === 'sub')!;
    for (const child of events.filter((e) => e.event_type.startsWith('child_'))) {
      expect(child.sequence_id).toBeGreaterThan(subStart.sequence_id);
      expect(child.sequence_id).toBeLessThan(subAction.sequence_id);
    }
  });

  it('assigns contiguous parent sequence ids across parent and child events', async () => {
    const { events } = await runParent();

    const sequences = events.map((e) => e.sequence_id);
    expect(sequences).toEqual(sequences.map((_, i) => i));
  });

  it('carries one child run id on every child event', async () => {
    const { events } = await runParent();

    const childRunIds = new Set(
      events
        .filter((e) => e.event_type.startsWith('child_'))
        .map((e) => e.internal_payload?.['_child_run_id']),
    );
    expect(childRunIds.size).toBe(1);
    expect([...childRunIds][0]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('replays the parent state identically with child events in the log', async () => {
    const { events, finalState } = await runParent();

    const started = events.find((e) => e.event_type === 'workflow_started')!;
    const config = (started.internal_payload?.config ?? {}) as Record<string, unknown>;
    const seed = createWorkflowState({
      workflowId: finalState.workflow_id,
      runId: finalState.run_id,
      goal: config.goal as string,
    });
    const replayed = replayEvents(events, seed).state;

    expect(replayed.status).toBe(finalState.status);
    expect(replayed.visited_nodes).toEqual(finalState.visited_nodes);
    expect(canonicalEquals(replayed.memory, finalState.memory)).toBe(true);
  });

  it('lists child boundaries separately from parent fork points', async () => {
    const { events } = await runParent();

    expect(forkPoints(events).map((p) => p.nodeId)).toEqual(['prep', 'sub', 'after']);

    const children = childForkPoints(events);
    expect(children.map((p) => p.nodeId)).toEqual(['sub/step-a', 'sub/step-b']);
    expect(children.every((p) => p.subgraphNodeId === 'sub')).toBe(true);
    expect(children.every((p) => typeof p.childRunId === 'string')).toBe(true);
  });

  it('ignores a child row that carries no node id', async () => {
    const { events } = await runParent();
    const malformed: WorkflowEvent = {
      id: uuidv4(),
      run_id: events[0]!.run_id,
      sequence_id: events.length,
      event_type: 'child_node_started',
      created_at: new Date(),
    } as WorkflowEvent;

    const boundaries = childForkPoints([...events, malformed]);

    expect(boundaries.map((p) => p.nodeId)).toEqual(['sub/step-a', 'sub/step-b']);
  });

  it('names a recorded child boundary as not yet addressable', async () => {
    const { events } = await runParent();

    expect(() => planForkPoint(events, { beforeNode: 'sub/step-a' }))
      .toThrow(/recorded .* not yet addressable/);
  });

  it('still reports an unknown namespaced node as never executed', async () => {
    const { events } = await runParent();

    expect(() => planForkPoint(events, { beforeNode: 'sub/never-ran' }))
      .toThrow(/never executed/);
  });

  it('reproduces the run exactly on a memoized null fork', async () => {
    const { events, eventLog, graph, finalState } = await runParent();

    const result = await fork(finalState.run_id, {
      at: 'start',
      eventLog,
      graph,
      registry: new InMemoryAgentRegistry(),
      runner: { tools: TOOLS, loadGraphFn: async (id) => (id === 'child-graph' ? CHILD_GRAPH : null) },
      policy: { memoize: true },
      ignoreBudget: true,
    });

    expect(result.state?.status).toBe(finalState.status);
    expect(result.state?.visited_nodes).toEqual(finalState.visited_nodes);
    const keys = new Set([...Object.keys(finalState.memory), ...Object.keys(result.state?.memory ?? {})]);
    for (const key of keys) {
      expect(canonicalEquals(result.state?.memory[key], finalState.memory[key])).toBe(true);
    }
    expect(events.some((e) => e.event_type === 'child_action_dispatched')).toBe(true);
  });
});

describe('nested subgraph child events', () => {
  it('prefixes grandchild events with both subgraph node ids', async () => {
    const grandchild: Graph = {
      id: 'grandchild-graph',
      name: 'grandchild',
      description: 'One leaf.',
      nodes: [toolNode('leaf', 'mark_a')],
      edges: [],
      start_node: 'leaf',
      end_nodes: ['leaf'],
    } as Graph;

    const middle: Graph = {
      id: 'middle-graph',
      name: 'middle',
      description: 'One subgraph.',
      nodes: [{
        id: 'inner',
        type: 'subgraph',
        subgraph_config: {
          subgraph_id: 'grandchild-graph',
          input_mapping: {},
          output_mapping: {},
          max_iterations: 50,
        },
        read_keys: ['*'],
        write_keys: ['*'],
        failure_policy: POLICY,
        requires_compensation: false,
      } as GraphNode],
      edges: [],
      start_node: 'inner',
      end_nodes: ['inner'],
    } as Graph;

    const parent: Graph = {
      id: uuidv4(),
      name: 'outer',
      description: 'One subgraph.',
      nodes: [{
        id: 'sub',
        type: 'subgraph',
        subgraph_config: {
          subgraph_id: 'middle-graph',
          input_mapping: {},
          output_mapping: {},
          max_iterations: 50,
        },
        read_keys: ['*'],
        write_keys: ['*'],
        failure_policy: POLICY,
        requires_compensation: false,
      } as GraphNode],
      edges: [],
      start_node: 'sub',
      end_nodes: ['sub'],
    } as Graph;

    const graphs = new Map<string, Graph>([['middle-graph', middle], ['grandchild-graph', grandchild]]);
    const eventLog = new InMemoryEventLogWriter();
    const state = createWorkflowState({ workflowId: parent.id, goal: 'nested threading' });
    const runner = new GraphRunner(parent, state, {
      eventLog,
      compactionInterval: 0,
      loadGraphFn: async (id) => graphs.get(id) ?? null,
      tools: TOOLS,
    });
    const finalState = await runner.run();
    const events: WorkflowEvent[] = await eventLog.loadEvents(finalState.run_id);

    expect(finalState.status).toBe('completed');
    const starts = events.filter((e) => e.event_type === 'child_node_started').map((e) => e.node_id);
    expect(starts).toEqual(['sub/inner', 'sub/inner/leaf']);

    const leafStart = events.find((e) => e.node_id === 'sub/inner/leaf')!;
    const innerStart = events.find((e) => e.node_id === 'sub/inner')!;
    expect(leafStart.internal_payload?.['_child_run_id'])
      .not.toBe(innerStart.internal_payload?.['_child_run_id']);
  });
});
