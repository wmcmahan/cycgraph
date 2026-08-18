/**
 * Tests for buildWorkflowProfile and describeLever (src/insights/profile.ts).
 */

import { describe, it, expect } from 'vitest';
import { buildWorkflowProfile, describeLever } from '../../src/insights/profile.js';
import type { NodeProfile } from '../../src/insights/profile.js';
import { run, timing, usage } from './helpers.js';

const SUPERVISED = {
  boss: { type: 'supervisor', total_ms: 8000, visits: 4 },
  worker: { type: 'agent', total_ms: 2000, visits: 1 },
};

function node(partial: Partial<NodeProfile>): NodeProfile {
  return {
    nodeId: 'n',
    type: 'agent',
    timeShare: 0.5,
    msPerRun: 100,
    msPerVisit: 100,
    visitsPerRun: 1,
    ...partial,
  };
}

describe('buildWorkflowProfile', () => {
  it('lists every node the workflow executed', () => {
    const profile = buildWorkflowProfile('wf', [run({ runId: 'r', nodeTiming: SUPERVISED })]);

    expect(profile!.nodes.map(n => n.nodeId)).toEqual(['boss', 'worker']);
  });

  it('orders nodes by what they contribute to a run', () => {
    const profile = buildWorkflowProfile('wf', [
      run({
        runId: 'r',
        nodeTiming: { small: timing(1), large: timing(9000), middling: timing(500) },
      }),
    ]);

    expect(profile!.nodes.map(n => n.nodeId)).toEqual(['large', 'middling', 'small']);
  });

  it('reports each node as a share of execution time', () => {
    const profile = buildWorkflowProfile('wf', [run({ runId: 'r', nodeTiming: SUPERVISED })]);

    expect(profile!.nodes[0]!.timeShare).toBe(0.8);
  });

  it('separates cost per visit from visit count', () => {
    const profile = buildWorkflowProfile('wf', [run({ runId: 'r', nodeTiming: SUPERVISED })]);

    expect(profile!.nodes[0]!.msPerVisit).toBe(2000);
    expect(profile!.nodes[0]!.visitsPerRun).toBe(4);
  });

  it('averages over the runs it was given', () => {
    const profile = buildWorkflowProfile('wf', [
      run({ runId: 'a', nodeTiming: { only: timing(1000) } }),
      run({ runId: 'b', nodeTiming: { only: timing(3000) } }),
    ]);

    expect(profile!.nodes[0]!.msPerRun).toBe(2000);
    expect(profile!.runs).toBe(2);
  });

  it('carries the node type through', () => {
    const profile = buildWorkflowProfile('wf', [run({ runId: 'r', nodeTiming: SUPERVISED })]);

    expect(profile!.nodes.map(n => n.type)).toEqual(['supervisor', 'agent']);
  });

  it('reports tokens per call alongside time', () => {
    const profile = buildWorkflowProfile('wf', [
      run({
        runId: 'r',
        nodeTiming: { a: timing(100) },
        byNode: { a: usage(600, 2) },
      }),
    ]);

    expect(profile!.nodes[0]!.tokensPerCall).toBe(300);
  });

  it('omits tokens per call for a node nothing attributed spend to', () => {
    const profile = buildWorkflowProfile('wf', [run({ runId: 'r', nodeTiming: { a: timing(100) } })]);

    expect(profile!.nodes[0]!.tokensPerCall).toBeUndefined();
  });

  it('includes a node that spent tokens but recorded no timing', () => {
    const profile = buildWorkflowProfile('wf', [
      run({ runId: 'r', nodeTiming: { a: timing(100) }, byNode: { untimed: usage(500) } }),
    ]);

    expect(profile!.nodes.map(n => n.nodeId)).toEqual(['a', 'untimed']);
  });

  it('ignores runs of other workflows', () => {
    const profile = buildWorkflowProfile('wf', [
      run({ runId: 'mine', nodeTiming: { a: timing(100) } }),
      run({ runId: 'theirs', workflow: 'other', nodeTiming: { b: timing(9000) } }),
    ]);

    expect(profile!.nodes.map(n => n.nodeId)).toEqual(['a']);
  });

  it('reports what a run costs in total', () => {
    const profile = buildWorkflowProfile('wf', [
      run({ runId: 'r', nodeTiming: SUPERVISED, byNode: { boss: usage(400), worker: usage(100) } }),
    ]);

    expect(profile!.msPerRun).toBe(10_000);
    expect(profile!.tokensPerRun).toBe(500);
  });

  it('reports the temperature a node sampled at', () => {
    const profile = buildWorkflowProfile('wf', [
      run({
        runId: 'r',
        nodeTiming: { a: timing(100) },
        logs: [{
          level: 'info',
          event: 'agent.executor.executing',
          context: { node_id: 'a', temperature: 0.7 },
        }],
      }),
    ]);

    expect(profile!.nodes[0]!.temperature).toEqual({ min: 0.7, max: 0.7 });
  });

  it('reports a scheduled temperature as the range it swept', () => {
    const logs = [1.0, 0.65, 0.3].map(temperature => ({
      level: 'info' as const,
      event: 'agent.executor.executing',
      context: { node_id: 'refine', temperature },
    }));

    const profile = buildWorkflowProfile('wf', [
      run({ runId: 'r', nodeTiming: { refine: timing(100, 'agent', 3) }, logs }),
    ]);

    expect(profile!.nodes[0]!.temperature).toEqual({ min: 0.3, max: 1.0 });
  });

  it('omits temperature for runs recorded before calls logged it', () => {
    const profile = buildWorkflowProfile('wf', [run({ runId: 'r', nodeTiming: { a: timing(100) } })]);

    expect(profile!.nodes[0]!.temperature).toBeUndefined();
  });

  it('ignores an executing line that names no node', () => {
    const profile = buildWorkflowProfile('wf', [
      run({
        runId: 'r',
        nodeTiming: { a: timing(100) },
        logs: [{ level: 'info', event: 'agent.executor.executing', context: { temperature: 0.7 } }],
      }),
    ]);

    expect(profile!.nodes[0]!.temperature).toBeUndefined();
  });

  it('names every model the runs were made against', () => {
    const profile = buildWorkflowProfile('wf', [
      run({ runId: 'a', model: 'qwen2.5:7b', nodeTiming: { a: timing(100) } }),
      run({ runId: 'b', model: 'llama3:8b', nodeTiming: { a: timing(100) } }),
      run({ runId: 'c', model: 'qwen2.5:7b', nodeTiming: { a: timing(100) } }),
    ]);

    expect(profile!.models).toEqual(['llama3:8b', 'qwen2.5:7b']);
  });

  it('reports no models when no run recorded one', () => {
    const profile = buildWorkflowProfile('wf', [run({ runId: 'a', nodeTiming: { a: timing(100) } })]);

    expect(profile!.models).toEqual([]);
  });

  it('returns nothing for a workflow with no runs', () => {
    expect(buildWorkflowProfile('missing', [run({ runId: 'r' })])).toBeUndefined();
  });

  it('returns nothing when no run recorded anything to profile', () => {
    expect(buildWorkflowProfile('wf', [run({ runId: 'r' })])).toBeUndefined();
  });
});

describe('describeLever', () => {
  it('points at the iteration budget for a repeatedly visited node', () => {
    expect(describeLever(node({ visitsPerRun: 4.2 }))).toContain('iteration or routing budget');
  });

  it('names how often the node is visited', () => {
    expect(describeLever(node({ visitsPerRun: 4.2 }))).toContain('4.2 times');
  });

  it('points at the prompt for a node visited once', () => {
    expect(describeLever(node({ visitsPerRun: 1 }))).toContain('prompt, model, or context budget');
  });
});
