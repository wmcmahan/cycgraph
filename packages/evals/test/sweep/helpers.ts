/**
 * Shared builders for the knob-sweep tests.
 */

import { createGraph } from '@cycgraph/orchestrator';
import type { Graph } from '@cycgraph/orchestrator';
import type { Finding } from '../../src/insights/types.js';
import type { NodeProfile, WorkflowProfile } from '../../src/insights/profile.js';
import type { BaselineOutcome, VariantOutcome } from '../../src/sweep/types.js';

export function supervisorGraph(maxIterations = 6): Graph {
  return createGraph({
    name: 'wf',
    description: 'a supervisor and one worker',
    nodes: [
      {
        id: 'boss',
        type: 'supervisor',
        agent_id: 'a1',
        supervisor_config: { managed_nodes: ['worker'], max_iterations: maxIterations },
      },
      { id: 'worker', type: 'agent', agent_id: 'a2' },
    ],
    startNode: 'boss',
    endNodes: [],
    edges: [
      { source: 'boss', target: 'worker', description: 'delegate' },
      { source: 'worker', target: 'boss', description: 'report' },
    ],
  });
}

export function annealingGraph(maxIterations = 8): Graph {
  return createGraph({
    name: 'wf',
    description: 'an annealing loop',
    nodes: [
      // Annealing is a behaviour an agent node opts into, not a node type.
      {
        id: 'refine',
        type: 'agent',
        agent_id: 'a1',
        annealing_config: { max_iterations: maxIterations },
      },
    ],
    startNode: 'refine',
    endNodes: ['refine'],
    edges: [],
  });
}

export function finding(partial: Partial<Finding> & Pick<Finding, 'id'>): Finding {
  return {
    detector: 'signals',
    severity: 'high',
    workflow: 'wf',
    title: 't',
    detail: 'd',
    evidence: { runs: 2, occurrences: 2, sampleRunIds: ['r'], of: 2 },
    addresses: 'a',
    ...partial,
  };
}

export function nodeProfile(partial: Partial<NodeProfile>): NodeProfile {
  return {
    nodeId: 'boss',
    type: 'supervisor',
    timeShare: 0.66,
    msPerRun: 11_000,
    msPerVisit: 2600,
    visitsPerRun: 4.2,
    ...partial,
  };
}

export function workflowProfile(nodes: NodeProfile[], workflow = 'wf'): WorkflowProfile {
  return { workflow, runs: 10, msPerRun: 12_000, tokensPerRun: 1800, nodes };
}

export function baseline(partial: Partial<BaselineOutcome> = {}): BaselineOutcome {
  return { runId: 'base', assertionsHeld: true, computeMs: 10_000, tokens: 1000, ...partial };
}

export function outcome(partial: Partial<VariantOutcome> & Pick<VariantOutcome, 'name'>): VariantOutcome {
  return {
    assertionsHeld: true,
    failed: [],
    computeMs: 10_000,
    tokens: 1000,
    ...partial,
  };
}
