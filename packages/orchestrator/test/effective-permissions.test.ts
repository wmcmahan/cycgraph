/**
 * effective-permissions.test.ts
 *
 * Derived write grants: node types imply their control-flow permissions,
 * executor-owned result keys are auto-granted from node config, and the
 * validator warns on read_keys nothing in the graph can produce.
 */
import { describe, it, expect } from 'vitest';
import {
  effectiveReadKeys,
  effectiveWriteKeys,
  impliedActionPermissions,
  impliedResultKeys,
  intersectWriteGrant,
} from '../src/security/effective-permissions.js';
import { extractMemoryUpdates } from '../src/agents/executors/agent/memory.js';
import { validateGraph } from '../src/graph/graph-validator.js';
import { validateAction } from '../src/state/reducers.js';
import { createGraph } from '../src/graph/graph.js';
import type { GraphNode } from '../src/graph/graph.js';
import type { Action } from '../src/state/state.js';
import { v4 as uuidv4 } from 'uuid';

const node = (overrides: Partial<GraphNode>): GraphNode => ({
  id: 'n',
  type: 'agent',
  read_keys: [],
  write_keys: [],
  failure_policy: { max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 1, max_backoff_ms: 1 },
  requires_compensation: false,
  ...overrides,
} as GraphNode);

describe('impliedActionPermissions', () => {
  it('supervisor implies control_flow and status', () => {
    expect(impliedActionPermissions(node({ type: 'supervisor' }))).toEqual(['control_flow', 'status']);
  });

  it('approval and subgraph imply control_flow', () => {
    expect(impliedActionPermissions(node({ type: 'approval' }))).toEqual(['control_flow']);
    expect(impliedActionPermissions(node({ type: 'subgraph' }))).toEqual(['control_flow']);
  });

  it('swarm-config agent implies control_flow; plain agent implies nothing', () => {
    expect(impliedActionPermissions(node({ type: 'agent', swarm_config: { peer_nodes: ['p'], max_handoffs: 5, handoff_mode: 'agent_choice' } }))).toEqual(['control_flow']);
    expect(impliedActionPermissions(node({ type: 'agent' }))).toEqual([]);
  });
});

describe('impliedResultKeys', () => {
  it('verifier implies its result key pair (default and explicit)', () => {
    expect(impliedResultKeys(node({ id: 'check', type: 'verifier' })))
      .toEqual(['check_verification', 'check_verification_passed']);
    expect(impliedResultKeys(node({
      id: 'check', type: 'verifier',
      verifier_config: { type: 'expression', expression: '1 == 1', result_key: 'ok', throw_on_fail: false },
    }))).toEqual(['ok', 'ok_passed']);
  });

  it('reflection, map, voting, evolution, tool, synthesizer imply their keys', () => {
    expect(impliedResultKeys(node({ id: 'r', type: 'reflection' }))).toEqual(['r_reflection']);
    expect(impliedResultKeys(node({ id: 'm', type: 'map' }))).toEqual(['m_results', 'm_errors', 'm_count', 'm_error_count']);
    expect(impliedResultKeys(node({ id: 'v', type: 'voting' }))).toEqual(['v_consensus', 'v_votes']);
    expect(impliedResultKeys(node({ id: 'e', type: 'evolution' }))).toContain('e_winner');
    expect(impliedResultKeys(node({ id: 't', type: 'tool' }))).toEqual(['t_result']);
    expect(impliedResultKeys(node({ id: 's', type: 'synthesizer' }))).toEqual(['s_synthesis']);
  });

  it('agent fallback output key is deliberately NOT implied', () => {
    expect(impliedResultKeys(node({ id: 'a', type: 'agent' }))).toEqual([]);
  });

  it('subgraph implies the parent-side keys of its output mapping', () => {
    const sub = node({
      id: 'call',
      type: 'subgraph',
      subgraph_config: {
        subgraph_id: 'child',
        input_mapping: { seed: 'topic' },
        output_mapping: { work_result: 'findings', notes: 'raw_notes' },
        max_iterations: 10,
      },
    });

    expect(impliedResultKeys(sub)).toEqual(['findings', 'raw_notes']);
  });

  it('subgraph with no output mapping implies no result keys', () => {
    const sub = node({
      id: 'call',
      type: 'subgraph',
      subgraph_config: { subgraph_id: 'child', input_mapping: {}, output_mapping: {}, max_iterations: 10 },
    });

    expect(impliedResultKeys(sub)).toEqual([]);
  });
});

describe('validateAction with effective keys', () => {
  const handoff = (): Action => ({
    id: uuidv4(),
    idempotency_key: uuidv4(),
    type: 'handoff',
    payload: { node_id: 'w', supervisor_id: 's', reasoning: 'r' },
    metadata: { node_id: 's', timestamp: new Date(), attempt: 1 },
  });

  it('a supervisor with EMPTY write_keys passes handoff validation via implied grants', () => {
    const sup = node({ type: 'supervisor', write_keys: [] });
    expect(validateAction(handoff(), sup.write_keys)).toBe(false);
    expect(validateAction(handoff(), effectiveWriteKeys(sup))).toBe(true);
  });

  it('a verifier with EMPTY write_keys passes its result-key write', () => {
    const verifier = node({
      id: 'check', type: 'verifier',
      verifier_config: { type: 'expression', expression: '1 == 1', throw_on_fail: false },
    });
    const action: Action = {
      id: uuidv4(),
      idempotency_key: uuidv4(),
      type: 'update_memory',
      payload: { updates: { check_verification: { passed: true }, check_verification_passed: true } },
      metadata: { node_id: 'check', timestamp: new Date(), attempt: 1 },
    };
    expect(validateAction(action, effectiveWriteKeys(verifier))).toBe(true);
  });

  it('a subgraph with EMPTY write_keys passes its mapped output write', () => {
    const sub = node({
      id: 'call',
      type: 'subgraph',
      write_keys: [],
      subgraph_config: {
        subgraph_id: 'child',
        input_mapping: { seed: 'topic' },
        output_mapping: { work_result: 'findings' },
        max_iterations: 10,
      },
    });
    const action: Action = {
      id: uuidv4(),
      idempotency_key: uuidv4(),
      type: 'update_memory',
      payload: { updates: { findings: 'child produced this' } },
      metadata: { node_id: 'call', timestamp: new Date(), attempt: 1 },
    };

    expect(validateAction(action, sub.write_keys)).toBe(false);
    expect(validateAction(action, effectiveWriteKeys(sub))).toBe(true);
  });

  it('a subgraph may not write a key its output mapping never names', () => {
    const sub = node({
      id: 'call',
      type: 'subgraph',
      write_keys: [],
      subgraph_config: {
        subgraph_id: 'child',
        input_mapping: {},
        output_mapping: { work_result: 'findings' },
        max_iterations: 10,
      },
    });
    const action: Action = {
      id: uuidv4(),
      idempotency_key: uuidv4(),
      type: 'update_memory',
      payload: { updates: { unrelated_key: 'nope' } },
      metadata: { node_id: 'call', timestamp: new Date(), attempt: 1 },
    };

    expect(validateAction(action, effectiveWriteKeys(sub))).toBe(false);
  });
});

describe('validateGraph — permission simplification', () => {
  it('a supervisor graph with empty write_keys is valid', () => {
    const graph = createGraph({
      name: 'sup', description: '', startNode: 'sup', endNodes: [],
      nodes: [
        { id: 'sup', type: 'supervisor', agentId: 'a', supervisorConfig: { managedNodes: ['w'], maxIterations: 5 } },
        { id: 'w', type: 'agent', agentId: 'b', writeKeys: ['out'] },
      ],
      edges: [
        { source: 'sup', target: 'w' },
        { source: 'w', target: 'sup' },
      ],
    });
    const result = validateGraph(graph);
    expect(result.valid).toBe(true);
  });

  it('warns on a read_keys entry nothing can produce', () => {
    const graph = createGraph({
      name: 'g', description: '', startNode: 'a', endNodes: ['b'],
      nodes: [
        { id: 'a', type: 'agent', agentId: 'x', writeKeys: ['notes'] },
        { id: 'b', type: 'agent', agentId: 'y', readKeys: ['notse'], writeKeys: ['out'] },
      ],
      edges: [{ source: 'a', target: 'b' }],
    });
    const result = validateGraph(graph);
    expect(result.warnings.some((w) => w.includes("'notse'") && w.includes('not produced'))).toBe(true);
  });

  it('does not warn when the key is produced, implied, or a wildcard writer exists', () => {
    const produced = createGraph({
      name: 'g', description: '', startNode: 'check', endNodes: ['b'],
      nodes: [
        { id: 'check', type: 'verifier', verifierConfig: { type: 'expression', expression: '1 == 1' } },
        { id: 'b', type: 'agent', agentId: 'y', readKeys: ['check_verification_passed'], writeKeys: ['out'] },
      ],
      edges: [{ source: 'check', target: 'b' }],
    });
    expect(validateGraph(produced).warnings.some((w) => w.includes('not produced'))).toBe(false);

    const wildcard = createGraph({
      name: 'g', description: '', startNode: 'a', endNodes: ['b'],
      nodes: [
        { id: 'a', type: 'agent', agentId: 'x', writeKeys: ['*'] },
        { id: 'b', type: 'agent', agentId: 'y', readKeys: ['anything_at_all'], writeKeys: ['out'] },
      ],
      edges: [{ source: 'a', target: 'b' }],
    });
    expect(validateGraph(wildcard).warnings.some((w) => w.includes('not produced'))).toBe(false);
  });
});

describe('intersectWriteGrant (ceiling-and-grant — ADR 001)', () => {
  it('no ceiling: the grant alone governs', () => {
    expect(intersectWriteGrant(['draft'], undefined)).toEqual(['draft']);
  });

  it('no grant and no ceiling (direct executor use): uncapped', () => {
    expect(intersectWriteGrant(undefined, undefined)).toEqual(['*']);
  });

  it('no grant (direct executor use): the ceiling governs', () => {
    expect(intersectWriteGrant(undefined, ['notes'])).toEqual(['notes']);
  });

  it('explicit EMPTY ceiling stays deny-all', () => {
    expect(intersectWriteGrant(['draft', 'notes'], [])).toEqual([]);
  });

  it('wildcard on either side defers to the other', () => {
    expect(intersectWriteGrant(['*'], ['notes'])).toEqual(['notes']);
    expect(intersectWriteGrant(['draft'], ['*'])).toEqual(['draft']);
    expect(intersectWriteGrant(['*'], ['*'])).toEqual(['*']);
  });

  it('plain intersection otherwise', () => {
    expect(intersectWriteGrant(['draft', 'notes'], ['draft', 'secrets'])).toEqual(['draft']);
  });

  it('fixes the shared-agent routing drop: broad ceiling + narrow grant routes text', () => {
    const effective = intersectWriteGrant(['draft'], ['notes', 'draft']);
    const updates = extractMemoryUpdates('the written draft', [], effective, 'node_output');
    expect(updates.draft).toBe('the written draft');
  });
});

describe('effectiveReadKeys', () => {
  const teamGraph = () => createGraph({
    name: 'team',
    description: 'supervisor over two workers',
    nodes: [
      {
        id: 'supervisor',
        type: 'supervisor',
        agentId: uuidv4(),
        supervisorConfig: { managedNodes: ['research', 'write'], maxIterations: 5 },
      },
      { id: 'research', type: 'agent', agentId: uuidv4(), readKeys: ['goal'], writeKeys: ['notes'] },
      { id: 'write', type: 'agent', agentId: uuidv4(), readKeys: ['notes'], writeKeys: ['draft'] },
    ],
    edges: [
      { source: 'supervisor', target: 'research' },
      { source: 'supervisor', target: 'write' },
      { source: 'research', target: 'supervisor' },
      { source: 'write', target: 'supervisor' },
    ],
    startNode: 'supervisor',
    endNodes: [],
  });

  it('derives supervisor reads from managed nodes when none are declared', () => {
    const graph = teamGraph();
    const supervisor = graph.nodes.find((n) => n.id === 'supervisor')!;

    const keys = effectiveReadKeys(supervisor, graph);

    expect([...keys].sort()).toEqual(
      ['draft', 'notes', 'research_output', 'write_output'].sort(),
    );
  });

  it('honors explicit supervisor reads over the derivation', () => {
    const graph = teamGraph();
    const supervisor = { ...graph.nodes.find((n) => n.id === 'supervisor')!, read_keys: ['notes'] };

    expect(effectiveReadKeys(supervisor, graph)).toEqual(['notes']);
  });

  it('returns declared reads unchanged for non-supervisor nodes', () => {
    const graph = teamGraph();
    const research = graph.nodes.find((n) => n.id === 'research')!;

    expect(effectiveReadKeys(research, graph)).toBe(research.read_keys);
  });

  it('derives a managed tool node implied result key it never declared', () => {
    const graph = createGraph({
      name: 'team',
      description: 'supervisor over a tool node',
      nodes: [
        {
          id: 'supervisor',
          type: 'supervisor',
          agentId: uuidv4(),
          supervisorConfig: { managedNodes: ['fetch'], maxIterations: 5 },
        },
        { id: 'fetch', type: 'tool', toolId: 'lookup' },
      ],
      edges: [{ source: 'supervisor', target: 'fetch' }],
      startNode: 'supervisor',
      endNodes: [],
    });
    const supervisor = graph.nodes.find((n) => n.id === 'supervisor')!;

    expect([...effectiveReadKeys(supervisor, graph)].sort()).toEqual(
      ['fetch_output', 'fetch_result'].sort(),
    );
  });

  it('derives a managed subgraph node mapped output it never declared', () => {
    const graph = createGraph({
      name: 'team',
      description: 'supervisor over a subgraph node',
      nodes: [
        {
          id: 'supervisor',
          type: 'supervisor',
          agentId: uuidv4(),
          supervisorConfig: { managedNodes: ['call'], maxIterations: 5 },
        },
        {
          id: 'call',
          type: 'subgraph',
          subgraphConfig: {
            subgraphId: 'child',
            inputMapping: { seed: 'topic' },
            outputMapping: { work_result: 'findings' },
          },
        },
      ],
      edges: [{ source: 'supervisor', target: 'call' }],
      startNode: 'supervisor',
      endNodes: [],
    });
    const supervisor = graph.nodes.find((n) => n.id === 'supervisor')!;

    expect([...effectiveReadKeys(supervisor, graph)].sort()).toEqual(
      ['call_output', 'findings'].sort(),
    );
  });

  it('excludes action pseudo-keys from the derivation', () => {
    const graph = createGraph({
      name: 'team',
      description: 'supervisor over an approval node',
      nodes: [
        {
          id: 'supervisor',
          type: 'supervisor',
          agentId: uuidv4(),
          supervisorConfig: { managedNodes: ['gate'], maxIterations: 5 },
        },
        { id: 'gate', type: 'approval', approvalConfig: { prompt: 'ok?' } },
      ],
      edges: [{ source: 'supervisor', target: 'gate' }],
      startNode: 'supervisor',
      endNodes: [],
    });
    const supervisor = graph.nodes.find((n) => n.id === 'supervisor')!;

    expect(effectiveReadKeys(supervisor, graph)).toEqual(['gate_output']);
  });

  it('propagates a managed wildcard writer into the derivation', () => {
    const graph = teamGraph();
    const wildcardWrite = {
      ...graph,
      nodes: graph.nodes.map((n) => (n.id === 'write' ? { ...n, write_keys: ['*'] } : n)),
    };
    const supervisor = wildcardWrite.nodes.find((n) => n.id === 'supervisor')!;

    expect(effectiveReadKeys(supervisor, wildcardWrite)).toContain('*');
  });
});

describe('effectiveReadKeys — approval review keys', () => {
  const gate = (approval: Record<string, unknown>, readKeys: string[] = []) => ({
    id: 'gate',
    type: 'approval' as const,
    read_keys: readKeys,
    write_keys: [],
    approval_config: {
      approval_type: 'human_review' as const,
      prompt_message: 'ok?',
      timeout_ms: 1000,
      ...approval,
    },
    failure_policy: { max_retries: 0, backoff_ms: 0, backoff_strategy: 'fixed' as const },
  });
  const graph = { nodes: [], edges: [] } as never;

  it('widens reads by the keys the reviewer is shown', () => {
    const node = gate({ review_keys: ['draft_result'] });

    expect(effectiveReadKeys(node as never, graph)).toEqual(['draft_result']);
  });

  it('keeps declared reads alongside the reviewed keys', () => {
    const node = gate({ review_keys: ['draft_result'] }, ['goal']);

    expect(effectiveReadKeys(node as never, graph).sort()).toEqual(['draft_result', 'goal']);
  });

  it('does not widen a wildcard into a full-memory grant', () => {
    const node = gate({ review_keys: ['*'] }, ['draft_result']);

    expect(effectiveReadKeys(node as never, graph)).toEqual(['draft_result']);
  });

  it('leaves a node whose reviewed keys it already reads untouched', () => {
    const node = gate({ review_keys: ['draft_result'] }, ['draft_result']);

    expect(effectiveReadKeys(node as never, graph)).toBe(node.read_keys);
  });
});
