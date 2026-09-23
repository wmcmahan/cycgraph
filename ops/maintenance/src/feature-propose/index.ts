/**
 * feature-propose — the feature-ticket ladder's first rung.
 *
 * An agent studies the codebase read-only and writes one well-formed
 * feature proposal: motivation, design sketch, evidence naming real files,
 * and mechanically checkable acceptance criteria. The gate is structural
 * (`proposal.ts`) — a proposal a human cannot review is refused, and
 * evidence must name at least one path the repository actually has. What
 * passes becomes a ticket, marker-keyed and deduped; approval, implementation,
 * and the PR ride the same ladder as every other approved issue, and the
 * merge is the feature's only honest fitness signal.
 *
 * Nothing is edited: the proposer's hands are search and read only.
 *
 * This file is the composer: `build` resolves the shared context, then
 * assembles the tools, the agents, the nodes, and the graph, each from its
 * own file.
 *
 * @module maintenance/feature-propose
 */

import type { EvalAssertion } from '@cycgraph/orchestrator';
import { buildFeatProposeContext, params } from './context.js';
import type { Params } from './context.js';
import { featProposeTools } from './tools/index.js';
import { surveyorAgent, drafterAgent } from './agents/index.js';
import { featProposeNodes } from './nodes/index.js';
import { featProposeGraph } from './graph.js';
import type { MaintenanceEnv, MaintenanceWorkflow } from '../types.js';

/** The feature-propose workflow. */
export function featPropose(): MaintenanceWorkflow<typeof params> {
  return {
    id: 'feature-propose',
    title: 'Propose one well-formed feature as a ticket',
    covers: ['maintenance', 'feature', 'proposal'],
    params,

    build: async (p: Params, env: MaintenanceEnv) => {
      const context = await buildFeatProposeContext(p, env);
      const tools = featProposeTools(context);
      const agents = { surveyor: surveyorAgent(context, tools), drafter: drafterAgent(context) };
      const nodes = featProposeNodes(tools, agents);
      return featProposeGraph(context, nodes);
    },

    evals: (): EvalAssertion[] => [
      { type: 'status_equals', expected: 'completed' },
      { type: 'memory_contains', key: 'shape_result' },
    ],
  };
}
