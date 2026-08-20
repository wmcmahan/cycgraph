/**
 * Tests for the mid-child fork driver (replay/fork-child.ts): extracting a
 * child session from a parent log, forking it, and continuing the parent
 * with the variant's mapped output.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { GraphRunner } from '../src/execution/engine/graph-runner.js';
import { InMemoryEventLogWriter } from '../src/persistence/event-log.js';
import { InMemoryAgentRegistry } from '../src/persistence/in-memory.js';
import { defineTool } from '../src/tools/define-tool.js';
import { forkInChild, extractChildLog } from '../src/replay/fork-child.js';
import { canonicalEquals } from '../src/replay/canonical.js';
import { createWorkflowState } from '../src/state/state.js';
import type { Graph, GraphNode } from '../src/graph/graph.js';
import type { WorkflowEvent } from '../src/persistence/event.js';

const POLICY = { max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 0, max_backoff_ms: 0 } as const;
const CHILD_GRAPH_ID = uuidv4();

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
  id: CHILD_GRAPH_ID,
  name: 'child',
  description: 'Two tool steps.',
  nodes: [toolNode('step-a', 'mark_a'), toolNode('step-b', 'mark_b')],
  edges: [{ id: uuidv4(), source: 'step-a', target: 'step-b', condition: { type: 'always' } }],
  start_node: 'step-a',
  end_nodes: ['step-b'],
} as Graph;

function parentGraph(): Graph {
  return {
    id: uuidv4(),
    name: 'parent',
    description: 'Tool, subgraph, tool.',
    nodes: [
      toolNode('prep', 'mark_prep'),
      {
        id: 'sub',
        type: 'subgraph',
        subgraph_config: {
          subgraph_id: CHILD_GRAPH_ID,
          input_mapping: {},
          output_mapping: { 'step-a_result': 'child_output_a', 'step-b_result': 'child_output_b' },
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
const loadGraph = async (id: string) => (id === CHILD_GRAPH_ID ? CHILD_GRAPH : null);

async function recordParentRun() {
  const eventLog = new InMemoryEventLogWriter();
  const graph = parentGraph();
  const state = createWorkflowState({ workflowId: graph.id, goal: 'mid-child forking' });
  const runner = new GraphRunner(graph, state, {
    eventLog,
    compactionInterval: 0,
    loadGraphFn: loadGraph,
    tools: TOOLS,
  });
  const finalState = await runner.run();
  const events = await eventLog.loadEvents(finalState.run_id);
  return { eventLog, graph, finalState, events };
}

function forkOptions(base: Awaited<ReturnType<typeof recordParentRun>>) {
  return {
    eventLog: base.eventLog,
    graph: base.graph,
    registry: new InMemoryAgentRegistry(),
    loadGraph,
    runner: { tools: TOOLS, loadGraphFn: loadGraph },
    ignoreBudget: true,
  };
}

describe('forkInChild', () => {
  it('reproduces the run on a null mid-child fork', async () => {
    const base = await recordParentRun();

    const result = await forkInChild(base.finalState.run_id, {
      ...forkOptions(base),
      at: { beforeNode: 'sub/step-b' },
    });

    expect(result.child.state?.status).toBe('completed');
    expect(result.parent?.state?.status).toBe('completed');
    expect(result.parent?.state?.visited_nodes).toEqual(base.finalState.visited_nodes);
    expect(canonicalEquals(result.parent?.state?.memory, base.finalState.memory)).toBe(true);
  });

  it('carries a changed child output through the parent mapping', async () => {
    const base = await recordParentRun();

    const result = await forkInChild(base.finalState.run_id, {
      ...forkOptions(base),
      at: { beforeNode: 'sub/step-a' },
      change: { kind: 'tool', node_id: 'step-a', result: 'DIFFERENT' },
    });

    expect(result.child.state?.memory['step-a_result']).toBe('DIFFERENT');
    expect(result.parent?.state?.memory['child_output_a']).toBe('DIFFERENT');
    expect(canonicalEquals(
      result.parent?.state?.memory['child_output_b'],
      base.finalState.memory['child_output_b'],
    )).toBe(true);
  });

  it('strips the subgraph namespace from change targets', async () => {
    const base = await recordParentRun();

    const result = await forkInChild(base.finalState.run_id, {
      ...forkOptions(base),
      at: { beforeNode: 'sub/step-a' },
      change: { kind: 'tool', node_id: 'sub/step-a', result: 'NAMESPACED' },
    });

    expect(result.parent?.state?.memory['child_output_a']).toBe('NAMESPACED');
  });

  it('returns the child fork alone when the parent tail is declined', async () => {
    const base = await recordParentRun();

    const result = await forkInChild(base.finalState.run_id, {
      ...forkOptions(base),
      at: { beforeNode: 'sub/step-b' },
      continueParent: false,
    });

    expect(result.child.state?.status).toBe('completed');
    expect(result.parent).toBeUndefined();
    expect(result.parentSkipped).toBeUndefined();
  });

  it('rejects an address with no subgraph namespace', async () => {
    const base = await recordParentRun();

    await expect(forkInChild(base.finalState.run_id, {
      ...forkOptions(base),
      at: { beforeNode: 'prep' },
    })).rejects.toThrow(/names no subgraph/);
  });

  it('rejects an address deeper than one level', async () => {
    const base = await recordParentRun();

    await expect(forkInChild(base.finalState.run_id, {
      ...forkOptions(base),
      at: { beforeNode: 'sub/inner/leaf' },
    })).rejects.toThrow(/One level per call/);
  });

  it('names the recorded boundaries when the address never executed', async () => {
    const base = await recordParentRun();

    await expect(forkInChild(base.finalState.run_id, {
      ...forkOptions(base),
      at: { beforeNode: 'sub/never-ran' },
    })).rejects.toThrow(/sub\/step-a, sub\/step-b/);
  });

  it('rejects an occurrence the child never reached', async () => {
    const base = await recordParentRun();

    await expect(forkInChild(base.finalState.run_id, {
      ...forkOptions(base),
      at: { beforeNode: 'sub/step-a', occurrence: 3 },
    })).rejects.toThrow(/executed 1 time/);
  });
});

describe('forkInChild option handling', () => {
  it('threads caller run ids into both halves', async () => {
    const base = await recordParentRun();
    const runId = uuidv4();
    const childVariantRunId = uuidv4();

    const result = await forkInChild(base.finalState.run_id, {
      ...forkOptions(base),
      at: { beforeNode: 'sub/step-b' },
      runId,
      childVariantRunId,
      ignoreBudget: true,
      hitl: async () => ({ decision: 'approved' }),
    });

    expect(result.child.runId).toBe(childVariantRunId);
    expect(result.parent?.runId).toBe(runId);
  });

  it('memoizes both halves from one policy', async () => {
    const base = await recordParentRun();

    const result = await forkInChild(base.finalState.run_id, {
      ...forkOptions(base),
      at: { beforeNode: 'sub/step-b' },
      policy: { memoize: true },
      hitl: async () => ({ decision: 'approved' }),
    });

    expect(result.child.memoHits.length).toBeGreaterThan(0);
    expect(result.parent?.memoHits.length).toBeGreaterThan(0);
  });

  it('lets a parent policy differ from the child policy', async () => {
    const base = await recordParentRun();

    const result = await forkInChild(base.finalState.run_id, {
      ...forkOptions(base),
      at: { beforeNode: 'sub/step-b' },
      parentPolicy: { memoize: true },
    });

    expect(result.child.memoHits).toEqual([]);
    expect(result.parent?.memoHits.length).toBeGreaterThan(0);
  });

  it('strips the namespace from every change kind that names a node', async () => {
    const base = await recordParentRun();

    const result = await forkInChild(base.finalState.run_id, {
      ...forkOptions(base),
      at: { beforeNode: 'sub/step-a' },
      change: [
        { kind: 'output', node_id: 'sub/step-a', memory: { 'step-a_result': 'OUT' } },
        { kind: 'config', node_id: 'sub/step-b', patch: { requires_compensation: false } },
        { kind: 'route', from_node_id: 'sub/step-a', to_node_id: 'sub/step-b' },
        { kind: 'memory', set: { seeded: 'yes' } },
      ],
    });

    expect(result.child.state?.status).toBe('completed');
    expect(result.child.state?.memory['step-a_result']).toBe('OUT');
    expect(result.child.state?.memory['seeded']).toBe('yes');
    expect(result.parent?.state?.memory['child_output_a']).toBe('OUT');
  });

  it('refuses an agent change when nothing in the child drives an agent', async () => {
    const base = await recordParentRun();

    await expect(forkInChild(base.finalState.run_id, {
      ...forkOptions(base),
      at: { beforeNode: 'sub/step-a' },
      change: { kind: 'temperature', target: 'sub/step-a', temperature: 0.3 },
    })).rejects.toThrow();
  });

  it('forks a tool-only child with no registry or runner wiring at all', async () => {
    const base = await recordParentRun();

    const result = await forkInChild(base.finalState.run_id, {
      eventLog: base.eventLog,
      graph: base.graph,
      loadGraph,
      at: { beforeNode: 'sub/step-b' },
    });

    expect(result.child.state?.status).toBe('completed');
    expect(result.parent?.state?.status).toBe('completed');
  });

  it('addresses the last occurrence explicitly', async () => {
    const base = await recordParentRun();

    const result = await forkInChild(base.finalState.run_id, {
      ...forkOptions(base),
      at: { beforeNode: 'sub/step-b', occurrence: 'last' },
      continueParent: false,
    });

    expect(result.child.state?.status).toBe('completed');
  });

});

describe('forkInChild wiring errors', () => {
  it('demands the parent graph', async () => {
    const base = await recordParentRun();
    const { graph: _graph, ...options } = forkOptions(base);

    await expect(forkInChild(base.finalState.run_id, {
      ...options,
      at: { beforeNode: 'sub/step-a' },
    } as never)).rejects.toThrow(/pass the parent 'graph'/);
  });

  it('demands the parent event log', async () => {
    const base = await recordParentRun();
    const { eventLog: _log, ...options } = forkOptions(base);

    await expect(forkInChild(base.finalState.run_id, {
      ...options,
      at: { beforeNode: 'sub/step-a' },
    } as never)).rejects.toThrow(/pass the parent 'eventLog'/);
  });

  it('demands a child graph resolver', async () => {
    const base = await recordParentRun();
    const { loadGraph: _load, ...options } = forkOptions(base);

    await expect(forkInChild(base.finalState.run_id, {
      ...options,
      at: { beforeNode: 'sub/step-a' },
    } as never)).rejects.toThrow(/pass 'loadGraph'/);
  });

  it('rejects a namespace that is not a subgraph node', async () => {
    const base = await recordParentRun();

    await expect(forkInChild(base.finalState.run_id, {
      ...forkOptions(base),
      at: { beforeNode: 'prep/step-a' },
    })).rejects.toThrow(/'prep' is not a subgraph node/);
  });

  it('reports a child graph the resolver cannot produce', async () => {
    const base = await recordParentRun();

    await expect(forkInChild(base.finalState.run_id, {
      ...forkOptions(base),
      loadGraph: async () => null,
      at: { beforeNode: 'sub/step-a' },
    })).rejects.toThrow(/did not resolve/);
  });

  it('refuses a boundary recorded without a child run id', async () => {
    const base = await recordParentRun();
    const stripped = new InMemoryEventLogWriter();
    for (const event of base.events) {
      const { id: _id, created_at: _at, internal_payload, ...rest } = event;
      await stripped.append({
        ...rest,
        ...(internal_payload && event.event_type !== 'child_node_started'
          ? { internal_payload } : {}),
      });
    }

    await expect(forkInChild(base.finalState.run_id, {
      ...forkOptions(base),
      eventLog: stripped,
      at: { beforeNode: 'sub/step-a' },
    })).rejects.toThrow(/carries no child run id/);
  });
});

describe('extractChildLog', () => {
  const CHILD_RUN = 'aaaaaaaa-0000-4000-8000-000000000001';
  const OTHER_RUN = 'bbbbbbbb-0000-4000-8000-000000000002';

  const event = (
    sequence: number,
    type: WorkflowEvent['event_type'],
    nodeId: string | undefined,
    childRunId: string,
  ): WorkflowEvent => ({
    id: uuidv4(),
    run_id: 'parent-run',
    sequence_id: sequence,
    event_type: type,
    ...(nodeId !== undefined ? { node_id: nodeId } : {}),
    internal_payload: { _child_run_id: childRunId },
    created_at: new Date(0),
  } as WorkflowEvent);

  it('keeps only the addressed session when the subgraph ran twice', () => {
    const events = [
      event(10, 'child_workflow_started', 'sub', OTHER_RUN),
      event(11, 'child_node_started', 'sub/step-a', OTHER_RUN),
      event(20, 'child_workflow_started', 'sub', CHILD_RUN),
      event(21, 'child_node_started', 'sub/step-a', CHILD_RUN),
    ];

    const extracted = extractChildLog(events, 'sub', CHILD_RUN);

    expect(extracted.events).toHaveLength(2);
    expect(extracted.events[0]!.event_type).toBe('workflow_started');
    expect(extracted.events[1]!.node_id).toBe('step-a');
    expect(extracted.sequenceMap.get(21)).toBe(1);
    expect(extracted.sequenceMap.has(11)).toBe(false);
  });

  it('renumbers sequences from zero', () => {
    const events = [
      event(40, 'child_workflow_started', 'sub', CHILD_RUN),
      event(41, 'child_node_started', 'sub/step-a', CHILD_RUN),
      event(42, 'child_action_dispatched', 'sub/step-a', CHILD_RUN),
    ];

    const extracted = extractChildLog(events, 'sub', CHILD_RUN);

    expect(extracted.events.map((e) => e.sequence_id)).toEqual([0, 1, 2]);
    expect(extracted.events.every((e) => e.run_id === CHILD_RUN)).toBe(true);
  });

  it('keeps grandchild events as child events one level up', () => {
    const GRANDCHILD = 'cccccccc-0000-4000-8000-000000000003';
    const events = [
      event(50, 'child_workflow_started', 'sub', CHILD_RUN),
      event(51, 'child_workflow_started', 'sub/inner', GRANDCHILD),
      event(52, 'child_node_started', 'sub/inner/leaf', GRANDCHILD),
    ];

    const extracted = extractChildLog(events, 'sub', CHILD_RUN);

    expect(extracted.events[1]!.event_type).toBe('child_workflow_started');
    expect(extracted.events[1]!.node_id).toBe('inner');
    expect(extracted.events[2]!.event_type).toBe('child_node_started');
    expect(extracted.events[2]!.node_id).toBe('inner/leaf');
    expect(extracted.events[2]!.internal_payload?.['_child_run_id']).toBe(GRANDCHILD);
  });
});
