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
} from '../src/validation/effective-permissions.js';
import { extractMemoryUpdates } from '../src/agent/agent-executor/memory.js';
import { validateGraph } from '../src/validation/graph-validator.js';
import { validateAction } from '../src/reducers/index.js';
import { createGraph } from '../src/types/graph.js';
import type { GraphNode } from '../src/types/graph.js';
import type { Action } from '../src/types/state.js';
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
