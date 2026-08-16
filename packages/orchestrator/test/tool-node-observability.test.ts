/**
 * What a `tool` node reports about the call it makes and the taint it carries.
 *
 * Driven through `stream()`: the events come from the runner's context, so a
 * direct-executor test would not see them.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { GraphRunner, graph, node, state, tool } from '../src/index.js';
import type { StreamEvent } from '../src/index.js';

const runWith = async (execute: () => unknown): Promise<StreamEvent[]> => {
  const probe = tool({
    name: 'probe',
    description: 'Records that it was called.',
    parameters: z.object({}),
    execute,
  });

  const call = node({ id: 'call', type: 'tool', toolId: 'probe', tools: [probe], reads: [] });
  const g = graph({
    name: 'tool-observability',
    nodes: [call],
    startNode: call,
    endNodes: [call],
  });

  const events: StreamEvent[] = [];
  // `run()` threads inline tool registrations; the explicit path does not.
  const runner = new GraphRunner(g, state({ workflowId: g.id, goal: 'call the tool' }), { tools: [probe] });
  for await (const event of runner.stream()) events.push(event);
  return events;
};

const toolEvents = (events: StreamEvent[]) =>
  events.filter((e) => e.type === 'tool:call_start' || e.type === 'tool:call_finish');

describe('tool node call reporting', () => {
  it('emits a start and a finish around the call', async () => {
    const events = await runWith(() => ({ ok: true }));

    expect(toolEvents(events).map((e) => e.type))
      .toEqual(['tool:call_start', 'tool:call_finish']);
  });

  it('names the tool and the node on both events', async () => {
    const events = await runWith(() => ({ ok: true }));
    const [start, finish] = toolEvents(events) as Array<
      Extract<StreamEvent, { type: 'tool:call_start' | 'tool:call_finish' }>
    >;

    expect({ startTool: start!.tool_name, startNode: start!.node_id, finishTool: finish!.tool_name })
      .toEqual({ startTool: 'probe', startNode: 'call', finishTool: 'probe' });
  });

  it('pairs the finish to its start by call id', async () => {
    const events = await runWith(() => ({ ok: true }));
    const [start, finish] = toolEvents(events) as Array<
      Extract<StreamEvent, { type: 'tool:call_start' | 'tool:call_finish' }>
    >;

    expect(finish!.tool_call_id).toBe(start!.tool_call_id);
  });

  it('reports success for a tool that returns a value', async () => {
    const events = await runWith(() => ({ ok: true }));
    const finish = toolEvents(events).at(-1) as Extract<StreamEvent, { type: 'tool:call_finish' }>;

    expect(finish.success).toBe(true);
  });

  it('reports failure when the tool returns isError, which does not fail the node', async () => {
    const events = await runWith(() => ({ isError: true, content: 'upstream refused' }));
    const finish = toolEvents(events).at(-1) as Extract<StreamEvent, { type: 'tool:call_finish' }>;
    const terminal = events.at(-1)!;

    expect({ success: finish.success, terminal: terminal.type })
      .toEqual({ success: false, terminal: 'workflow:complete' });
  });

  it('reports failure and the message when the tool throws', async () => {
    const events = await runWith(() => { throw new Error('connection refused'); });
    const finish = toolEvents(events).at(-1) as Extract<StreamEvent, { type: 'tool:call_finish' }>;

    expect({ success: finish.success, error: finish.error })
      .toEqual({ success: false, error: 'connection refused' });
  });
});

describe('taint reporting', () => {
  const tainted = () => ({
    result: { records: ['external'] },
    taint: { source: 'mcp_tool', tool_name: 'probe', server_id: 'remote', created_at: '2024-01-01T00:00:00.000Z' },
  });

  it('emits taint:applied when a tool returns external data', async () => {
    const events = await runWith(tainted);
    const applied = events.filter((e) => e.type === 'taint:applied');

    expect(applied).toHaveLength(1);
  });

  it('names the key, the source, and the node that introduced it', async () => {
    const events = await runWith(tainted);
    const applied = events.find((e) => e.type === 'taint:applied') as
      Extract<StreamEvent, { type: 'taint:applied' }>;

    expect({ key: applied.key, source: applied.source, node: applied.node_id, server: applied.server_id })
      .toEqual({ key: 'call_result', source: 'mcp_tool', node: 'call', server: 'remote' });
  });

  it('reports the size of what arrived', async () => {
    const events = await runWith(tainted);
    const applied = events.find((e) => e.type === 'taint:applied') as
      Extract<StreamEvent, { type: 'taint:applied' }>;

    expect(applied.bytes).toBe(Buffer.byteLength(JSON.stringify({ records: ['external'] }), 'utf-8'));
  });

  it('stays silent for a tool that returns nothing external', async () => {
    const events = await runWith(() => ({ ok: true }));

    expect(events.some((e) => e.type === 'taint:applied')).toBe(false);
  });
});
