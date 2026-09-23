/**
 * optimization-propose — optimization proposals with measured evidence.
 *
 * The proposal tier's measurable half. An agent studies the benchmark
 * baseline, makes one optimization in a jailed clone, and the harness
 * re-benches: the verdict passes only when at least one benchmark improves
 * beyond the floor and the noise, none regresses, and every changed file
 * sits inside the allowed scope. What a passing run produces is a *ticket*,
 * not a PR — the issue carries the proposal, the measured table, and the
 * verified diff, and waits for a human to approve. Filing follows the
 * ledger rules: marker-keyed, deduped, and refused when the ledger cannot
 * be read.
 *
 * This file is the composer: `build` resolves the shared context, then
 * assembles the tools, the optimizer, the nodes, and the graph, each from
 * its own file.
 *
 * @module maintenance/optimization-propose
 */

import type { EvalAssertion } from '@cycgraph/orchestrator';
import { buildOptProposeContext, params } from './context.js';
import type { Params } from './context.js';
import { optProposeTools } from './tools/index.js';
import { optimizerAgent } from './agents/index.js';
import { optProposeNodes } from './nodes/index.js';
import { optProposeGraph } from './graph.js';
import type { MaintenanceEnv, MaintenanceWorkflow } from '../types.js';

/** The optimization-propose workflow. */
export function optPropose(): MaintenanceWorkflow<typeof params> {
  return {
    id: 'optimization-propose',
    title: 'Propose one measured optimization as a ticket',
    covers: ['maintenance', 'optimization', 'workspace'],
    params,

    build: async (p: Params, env: MaintenanceEnv) => {
      const context = await buildOptProposeContext(p, env);
      const tools = optProposeTools(context);
      const optimizer = optimizerAgent(context, tools);
      const nodes = optProposeNodes(tools, optimizer);
      return optProposeGraph(context, nodes);
    },

    evals: (): EvalAssertion[] => [
      { type: 'status_equals', expected: 'completed' },
      { type: 'memory_contains', key: 'verdict_result' },
    ],
  };
}
