/**
 * Tests for fork-point addressing (src/replay/fork-point.ts): resolving every
 * address form to the sequence a variant starts diverging at, and refusing the
 * ones that would split a node's execution.
 */

import { describe, it, expect } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { planForkPoint, forkPoints, ForkPointError } from '../src/replay/fork-point.js';
import type { WorkflowEvent } from '../src/persistence/event.js';

const RUN_ID = '11111111-1111-4111-8111-111111111111';
const T0 = new Date('2026-01-01T00:00:00.000Z');
const FACT_ID = 'fact-abc';

let sequence = 0;

function event(partial: Partial<WorkflowEvent> & Pick<WorkflowEvent, 'event_type'>): WorkflowEvent {
  return { id: uuidv4(), run_id: RUN_ID, sequence_id: sequence++, created_at: T0, ...partial };
}

function nodeStarted(nodeId: string): WorkflowEvent {
  return event({ event_type: 'node_started', node_id: nodeId });
}

function action(
  nodeId: string,
  type: string,
  payload: Record<string, unknown>,
): WorkflowEvent {
  return event({
    event_type: 'action_dispatched',
    node_id: nodeId,
    action: {
      id: uuidv4(),
      idempotency_key: `${nodeId}:0:1`,
      type: type as 'update_memory',
      payload,
      metadata: { node_id: nodeId, timestamp: T0, attempt: 1 },
    },
  });
}

function writes(nodeId: string, updates: Record<string, unknown>): WorkflowEvent {
  return action(nodeId, 'update_memory', { updates });
}

function internal(type: string): WorkflowEvent {
  return event({ event_type: 'internal_dispatched', internal_type: type });
}

/** research → write → review, with `write` executing twice. */
function cyclicLog(): WorkflowEvent[] {
  sequence = 0;
  return [
    event({ event_type: 'workflow_started' }),
    internal('_init'),
    nodeStarted('research'),
    writes('research', { notes: 'n' }),
    internal('_increment_iteration'),
    internal('_advance'),
    nodeStarted('write'),
    writes('write', { draft: 'd1' }),
    internal('_increment_iteration'),
    internal('_advance'),
    nodeStarted('review'),
    writes('review', { verdict: 'redo' }),
    internal('_increment_iteration'),
    internal('_advance'),
    nodeStarted('write'),
    writes('write', { draft: 'd2' }),
    internal('_increment_iteration'),
    internal('_complete'),
  ];
}

describe('forkPoints', () => {
  it('lists every node execution in order', () => {
    const points = forkPoints(cyclicLog());

    expect(points.map(p => p.nodeId)).toEqual(['research', 'write', 'review', 'write']);
  });

  it('numbers repeat executions of the same node', () => {
    const points = forkPoints(cyclicLog());

    expect(points.filter(p => p.nodeId === 'write').map(p => p.occurrence)).toEqual([1, 2]);
  });

  it('reports the iteration each node started at', () => {
    const points = forkPoints(cyclicLog());

    expect(points.map(p => p.iteration)).toEqual([0, 1, 2, 3]);
  });

  it('returns nothing for a log with no node executions', () => {
    sequence = 0;
    expect(forkPoints([event({ event_type: 'workflow_started' }), internal('_init')])).toEqual([]);
  });
});

describe('planForkPoint', () => {
  it("resolves 'start' to the first node", () => {
    const plan = planForkPoint(cyclicLog(), 'start');

    expect(plan).toMatchObject({ kind: 'sequence', sequenceId: 2, nodeId: 'research' });
  });

  it('resolves a node name to its first execution', () => {
    const plan = planForkPoint(cyclicLog(), { beforeNode: 'write' });

    expect(plan).toMatchObject({ sequenceId: 6, nodeId: 'write' });
  });

  it('resolves a numbered occurrence of a repeated node', () => {
    const plan = planForkPoint(cyclicLog(), { beforeNode: 'write', occurrence: 2 });

    expect(plan).toMatchObject({ sequenceId: 14, nodeId: 'write' });
  });

  it("resolves occurrence 'last' to the final execution", () => {
    const plan = planForkPoint(cyclicLog(), { beforeNode: 'write', occurrence: 'last' });

    expect(plan).toMatchObject({ sequenceId: 14 });
  });

  it('resolves afterNode to the next node boundary, keeping the node output', () => {
    const plan = planForkPoint(cyclicLog(), { afterNode: 'research' });

    expect(plan).toMatchObject({ sequenceId: 6, nodeId: 'write' });
  });

  it('resolves afterNode on the last execution to one past the log', () => {
    const plan = planForkPoint(cyclicLog(), { afterNode: 'write', occurrence: 'last' });

    expect(plan).toMatchObject({ kind: 'sequence', sequenceId: 18 });
  });

  it('resolves an iteration to the node that started it', () => {
    const plan = planForkPoint(cyclicLog(), { beforeIteration: 2 });

    expect(plan).toMatchObject({ sequenceId: 10, nodeId: 'review' });
  });

  it('resolves a raw sequence that lands on a node boundary', () => {
    const plan = planForkPoint(cyclicLog(), { sequence: 10 });

    expect(plan).toMatchObject({ sequenceId: 10, nodeId: 'review' });
  });

  it('resolves the first write of a memory key to the node that wrote it', () => {
    const plan = planForkPoint(cyclicLog(), { beforeFirstWriteOf: 'verdict' });

    expect(plan).toMatchObject({ sequenceId: 10, nodeId: 'review' });
  });

  it('passes a where predicate through untouched', () => {
    const stopBefore = () => true;

    const plan = planForkPoint(cyclicLog(), { where: stopBefore });

    expect(plan).toEqual({ kind: 'predicate', stopBefore, description: 'a caller predicate' });
  });

  it('describes the resolved point for the fork report', () => {
    const plan = planForkPoint(cyclicLog(), { beforeNode: 'write', occurrence: 2 });

    expect(plan.description).toBe("before 'write' execution 2");
  });
});

describe('planForkPoint — failure', () => {
  function failedLog(): WorkflowEvent[] {
    sequence = 0;
    return [
      event({ event_type: 'workflow_started' }),
      internal('_init'),
      nodeStarted('research'),
      writes('research', { notes: 'n' }),
      internal('_increment_iteration'),
      internal('_advance'),
      nodeStarted('write'),
      internal('_fail'),
    ];
  }

  it('resolves to the node that was executing when the run failed', () => {
    const plan = planForkPoint(failedLog(), 'failure');

    expect(plan).toMatchObject({ sequenceId: 6, nodeId: 'write' });
  });

  it('refuses when the run did not fail', () => {
    expect(() => planForkPoint(cyclicLog(), 'failure')).toThrow(ForkPointError);
    expect(() => planForkPoint(cyclicLog(), 'failure')).toThrow(/did not fail/);
  });
});

describe('planForkPoint — human input', () => {
  it('resolves to the node that asked for approval', () => {
    sequence = 0;
    const events = [
      event({ event_type: 'workflow_started' }),
      internal('_init'),
      nodeStarted('research'),
      writes('research', { notes: 'n' }),
      internal('_advance'),
      nodeStarted('approve'),
      action('approve', 'request_human_input', { prompt: 'ok?' }),
    ];

    expect(planForkPoint(events, { beforeHumanInput: true })).toMatchObject({
      sequenceId: 5,
      nodeId: 'approve',
    });
  });

  it('refuses when the run never paused for input', () => {
    expect(() => planForkPoint(cyclicLog(), { beforeHumanInput: true })).toThrow(
      /never asked for human input/,
    );
  });
});

describe('planForkPoint — lesson provenance', () => {
  it('resolves to the node whose retrieval injected the fact', () => {
    sequence = 0;
    const events = [
      event({ event_type: 'workflow_started' }),
      internal('_init'),
      nodeStarted('research'),
      writes('research', { notes: 'n' }),
      internal('_advance'),
      nodeStarted('write'),
      writes('write', {
        draft: 'd',
        _lesson_provenance: { write: { fact_ids: [FACT_ID] } },
      }),
    ];

    expect(planForkPoint(events, { beforeFirstReadOf: FACT_ID })).toMatchObject({
      sequenceId: 5,
      nodeId: 'write',
    });
  });

  it('resolves provenance carried on a supervisor handoff', () => {
    sequence = 0;
    const events = [
      event({ event_type: 'workflow_started' }),
      internal('_init'),
      nodeStarted('supervise'),
      action('supervise', 'handoff', {
        node_id: 'write',
        supervisor_id: 's',
        reasoning: 'r',
        lesson_provenance: { supervise: { fact_ids: [FACT_ID] } },
      }),
    ];

    expect(planForkPoint(events, { beforeFirstReadOf: FACT_ID })).toMatchObject({
      nodeId: 'supervise',
    });
  });

  it('refuses with a hint about adapters that drop fact ids', () => {
    expect(() => planForkPoint(cyclicLog(), { beforeFirstReadOf: FACT_ID })).toThrow(
      /drop fact ids/,
    );
  });
});

describe('planForkPoint — invalid addresses', () => {
  it('refuses a sequence inside a node execution and names the node', () => {
    expect(() => planForkPoint(cyclicLog(), { sequence: 7 })).toThrow(
      /falls inside 'write's execution/,
    );
  });

  it('refuses a sequence missing from the log and points at compaction', () => {
    const events = cyclicLog().filter(e => e.sequence_id >= 6);

    expect(() => planForkPoint(events, { sequence: 2 })).toThrow(/compaction/);
  });

  it('refuses an unknown node and lists the ones that ran', () => {
    expect(() => planForkPoint(cyclicLog(), { beforeNode: 'wrtier' })).toThrow(
      /Nodes that did: research, write, review/,
    );
  });

  it('refuses an occurrence the node never reached', () => {
    expect(() => planForkPoint(cyclicLog(), { beforeNode: 'write', occurrence: 3 })).toThrow(
      /executed 2 time\(s\)/,
    );
  });

  it('refuses an iteration the run never reached', () => {
    expect(() => planForkPoint(cyclicLog(), { beforeIteration: 9 })).toThrow(/reached iteration 3/);
  });

  it('refuses a memory key no node wrote', () => {
    expect(() => planForkPoint(cyclicLog(), { beforeFirstWriteOf: 'summary' })).toThrow(
      /no node wrote that key/,
    );
  });

  it('reports that no nodes ran when the log is empty', () => {
    expect(() => planForkPoint([], { beforeNode: 'a' })).toThrow(/Nodes that did: \(none\)/);
    expect(() => planForkPoint([], { beforeNode: 'a' })).toThrow(ForkPointError);
  });

  it('accepts a sequence one past the end of the log', () => {
    const events = cyclicLog();
    const end = events[events.length - 1]!.sequence_id + 1;

    expect(planForkPoint(events, { sequence: end })).toMatchObject({ sequenceId: end });
  });

  it('reports a mid-group sequence before any node started', () => {
    sequence = 0;
    const events = [event({ event_type: 'workflow_started' }), internal('_init')];

    expect(() => planForkPoint(events, { sequence: 1 })).toThrow(/not a node boundary/);
  });

  it('refuses a failure that happened before any node started', () => {
    sequence = 0;
    const events = [event({ event_type: 'workflow_started' }), internal('_init'), internal('_fail')];

    expect(() => planForkPoint(events, 'failure')).toThrow(/failed before any node started/);
  });

  it('reports iteration 0 reached when the run started nothing', () => {
    sequence = 0;
    const events = [event({ event_type: 'workflow_started' }), internal('_init')];

    expect(() => planForkPoint(events, { beforeIteration: 3 })).toThrow(/reached iteration 0/);
  });

  it("refuses 'start' on a run that never started a node", () => {
    sequence = 0;
    const events = [event({ event_type: 'workflow_started' }), internal('_init')];

    expect(() => planForkPoint(events, 'start')).toThrow(/never started a node/);
  });
});
