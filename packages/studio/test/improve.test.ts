/** Tests for the improve ladder's topology (run/improve.ts). */

import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { buildImproveGraph, improveTuneTargetFor } from '../src/improve/improve.js';
import { catalogOf } from '../src/scenarios/catalog.js';
import { scenario } from '../src/scenarios/types.js';
import type { Stack } from '../src/stack/index.js';

const target = scenario({
  id: 'target',
  title: 'Target under improvement',
  covers: [],
  requires: [],
  params: z.object({}),
  build: async () => {
    throw new Error('build is only reached at execution time');
  },
});

const stack = { config: { artifactRoot: '/tmp/improve-test' } } as Stack;
const tuneTarget = improveTuneTargetFor(catalogOf([target]));

function build() {
  return buildImproveGraph(target, {}, stack, { repoRoot: '/tmp/repo', hitl: async () => ({ decision: 'approved' }) });
}

function buildWithApplyDriver() {
  return buildImproveGraph(target, {}, stack, {
    repoRoot: '/tmp/repo',
    hitl: async () => ({ decision: 'approved' }),
    drivers: {
      apply: async () => ({ branch: 'b', workspace: '/tmp/ws', files: [], prCommand: 'git push' }),
    },
  });
}

describe('buildImproveGraph', () => {
  it('walks the ladder tune, record, and three gates apart', () => {
    const g = build();

    const path = g.edges.map((edge) => `${edge.source}>${edge.target}`);
    expect(path).toContain('tune>record');
    expect(path).toContain('gate_trial>trial');
    expect(path).toContain('trial>gate_apply');
    expect(path).toContain('gate_apply>brief');
    expect(path).toContain('brief>clone');
    expect(path).toContain('clone>edit');
    expect(path).toContain('edit>ship');
    expect(path).toContain('ship>gate_merged');
    expect(path).toContain('gate_merged>merged');
  });

  it('embeds the fix-loop editor as a subgraph with mapped instruction and report', () => {
    const g = build();

    const edit = g.nodes.find((n) => n.id === 'edit');
    expect(edit?.type).toBe('subgraph');
    expect(edit?.subgraph_config?.input_mapping).toEqual({ brief_result: 'instruction' });
    expect(edit?.subgraph_config?.output_mapping).toEqual({ edit_report: 'edit_report' });
  });

  it('embeds the tune cycle as a subgraph landing its outcome under tune_result', () => {
    const g = build();

    const tune = g.nodes.find((n) => n.id === 'tune');
    expect(tune?.type).toBe('subgraph');
    expect(tune?.subgraph_config?.output_mapping).toEqual({ tune_result: 'tune_result' });
  });

  it('collapses the tune stage to one tool node when a driver is installed', () => {
    const g = buildImproveGraph(target, {}, stack, {
      repoRoot: '/tmp/repo',
      hitl: async () => ({ decision: 'approved' }),
      drivers: {
        tune: async () => { throw new Error('not called during build'); },
      },
    });

    expect(g.nodes.find((n) => n.id === 'tune')?.type).toBe('tool');
  });

  it('collapses the apply stage to one tool node when a driver is installed', () => {
    const g = buildWithApplyDriver();

    const path = g.edges.map((edge) => `${edge.source}>${edge.target}`);
    expect(path).toContain('gate_apply>apply');
    expect(path).toContain('apply>gate_merged');
    expect(g.nodes.find((n) => n.id === 'edit')).toBeUndefined();
    expect(g.nodes.find((n) => n.id === 'apply')?.type).toBe('tool');
  });

  it('routes an empty ledger straight to the report', () => {
    const g = build();

    const fromRecord = g.edges.filter((edge) => edge.source === 'record');
    const toGate = fromRecord.find((edge) => edge.target === 'gate_trial');
    const toLeave = fromRecord.find((edge) => edge.target === 'leave');
    expect(toGate?.condition).toEqual({ type: 'conditional', condition: 'memory.record_result.count > 0' });
    expect(toLeave?.condition).toEqual({ type: 'conditional', condition: 'memory.record_result.count == 0' });
  });

  it('routes every gate rejection to the report node', () => {
    const g = build();

    const gates = g.nodes.filter((n) => n.type === 'approval');
    expect(gates.map((n) => n.id).sort()).toEqual(['gate_apply', 'gate_merged', 'gate_trial']);
    for (const gate of gates) {
      expect(gate.approval_config?.rejection_node_id).toBe('leave');
    }
  });

  it('rebuilds the session shape from self-describing parameters', async () => {
    const params = tuneTarget.params.parse({ target: 'target' });

    const built = await tuneTarget.build(params as never, stack);

    const types = new Map(built.graph.nodes.map((n) => [n.id, n.type]));
    expect(types.get('tune')).toBe('subgraph');
    expect(types.get('edit')).toBe('subgraph');
    expect(built.hitl).toBeDefined();
  });

  it('refuses a session corpus whose target is not in the catalog', async () => {
    const params = tuneTarget.params.parse({ target: 'no-such-workflow' });

    await expect(tuneTarget.build(params as never, stack)).rejects.toThrow(/not in this catalog/);
  });

  it('ends at the epoch stamp or the report, nowhere else', () => {
    const g = build();

    expect([...g.end_nodes].sort()).toEqual(['leave', 'merged']);
    expect(g.start_node).toBe('tune');
  });
});
